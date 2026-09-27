"""DokaanBondhu speech worker (spec 14.1): speech-to-text and text-to-speech in one FastAPI app.

Serve: uvicorn speech_app:api. Prepare the models once: python speech_app.py prepare.
Tests run with SPEECH_LOAD_MODELS=0 and put fake models into `state`.
"""

from __future__ import annotations

import hmac
import io
import logging
import os
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

log = logging.getLogger("speech")
if not logging.getLogger().handlers:  # uvicorn configures only its own loggers
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Models, pinned (P2 records the hashes; architecture, AI models).
ASR_HF_ID = os.environ.get("ASR_HF_ID", "bengaliAI/tugstugi_bengaliai-asr_whisper-medium")
ASR_HF_REVISION = os.environ.get("ASR_HF_REVISION", "da605cc1bd2f60a18d8e440e977ddfa921a88e63")
ASR_MODEL_DIR = os.environ.get("ASR_MODEL_DIR", "models/tugstugi-ct2")
WHISPER_FALLBACK = ("openai/whisper-medium", "abdf7c39ab9d0397620ccaea8974cc764cd0953e")
TTS_MODEL_ID = os.environ.get("TTS_MODEL_ID", "ai4bharat/indic-parler-tts")
TTS_MODEL_REVISION = os.environ.get("TTS_MODEL_REVISION", "7b527af5ee8ed1f9a28d80b19703ed9bb8ba10ca")
SPEECH_VERSION = os.environ.get("SPEECH_VERSION", "dev")

SAMPLE_RATE = 16_000
MIN_CLIP_SECONDS = 0.3
MAX_CLIP_SECONDS = 30.0
MIN_SPEECH_SECONDS = 0.2
QUIET_RMS = 0.01
PROMPT_MAX_TOKENS = 80  # Whisper's window is 448 tokens for prompt and text together (D53)
VAD_PARAMETERS: dict[str, int] = {"min_silence_duration_ms": 300, "speech_pad_ms": 200}

# The main decode of the trimmed clip, with every quality gate of spec 14.1 (D53). Timestamp mode lost the first
# syllables of the clip (P2); word timestamps still come from alignment.
MAIN_DECODE: dict[str, Any] = {
    "language": "bn",
    "task": "transcribe",
    "beam_size": 5,
    "word_timestamps": True,
    "without_timestamps": True,
    "condition_on_previous_text": False,
    "vad_filter": True,
    "vad_parameters": VAD_PARAMETERS,
    "hallucination_silence_threshold": 0.5,
    "no_speech_threshold": 0.6,
    "compression_ratio_threshold": 2.2,
    "log_prob_threshold": -1.0,
    "repetition_penalty": 1.1,
    "no_repeat_ngram_size": 3,
    "temperature": [0.0, 0.2, 0.4],
}
# The N-best decode, straight on the CTranslate2 model (faster-whisper returns only the best transcript).
NBEST_DECODE: dict[str, Any] = {
    "return_scores": True,
    "max_length": 448,  # counts the prompt
    "suppress_blank": True,
    "repetition_penalty": 1.1,
    "no_repeat_ngram_size": 3,
}

VOICES = {"aditi": "Aditi", "arjun": "Arjun"}
WARM_PHRASES = ["ঠিক আছে?", "হয়ে গেছে।", "জেনুইন না নন-জেনুইন?", "আবার বলবেন?"]
TTS_CACHE_SIZE = 256


class AsrModel(Protocol):
    def count_tokens(self, text: str) -> int: ...

    def transcribe(
        self, audio: np.ndarray, *, initial_prompt: str | None, **options: Any
    ) -> tuple[str, list[dict[str, Any]]]: ...

    def nbest(self, audio: np.ndarray, *, prompt: str | None, **options: Any) -> list[tuple[str, float]]: ...


class TtsModel(Protocol):
    def synthesize(self, text: str, description: str) -> tuple[np.ndarray, int]: ...


@dataclass
class State:
    asr: AsrModel | None = None
    tts: TtsModel | None = None
    device: str = "none"
    ready: bool = False


state = State()
asr_lock = threading.Lock()  # one GPU inference at a time per model
tts_lock = threading.Lock()
cache_lock = threading.Lock()
tts_cache: OrderedDict[tuple[str, str, str], bytes] = OrderedDict()


# ---------------------------------------------------------------------------------------------- speech-to-text


class BadAudio(Exception):
    pass


def decode(data: bytes) -> np.ndarray:
    """Any format faster-whisper decodes, as 16 kHz mono float32."""
    from faster_whisper import decode_audio

    try:
        audio = decode_audio(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    except Exception as error:  # PyAV raises several error types for a file it cannot read
        raise BadAudio(str(error)) from error
    return np.asarray(audio, dtype=np.float32)


def rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if audio.size else 0.0


def speech_spans(audio: np.ndarray) -> list[tuple[int, int]]:
    """Silero VAD from faster-whisper, with the same parameters as the main decode."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    spans = get_speech_timestamps(audio, VadOptions(**VAD_PARAMETERS), sampling_rate=SAMPLE_RATE)
    return [(int(span["start"]), int(span["end"])) for span in spans]


def parse_keyterms(raw: str) -> list[str]:
    terms: list[str] = []
    for part in raw.replace("\n", ",").split(","):
        term = part.strip()
        if term and term not in terms:
            terms.append(term)
    return terms


def keyterm_prompt(terms: list[str], count_tokens: Callable[[str], int]) -> str:
    """The terms joined with ", ", stopped before they exceed 80 Whisper tokens."""
    prompt = ""
    for term in terms:
        candidate = f"{prompt}, {term}" if prompt else term
        if count_tokens(candidate) > PROMPT_MAX_TOKENS:
            break
        prompt = candidate
    return prompt


def transcribe_clip(data: bytes, keyterms: str, nbest: int, low_confidence_below: float) -> dict[str, Any]:
    started = time.perf_counter()
    asr = state.asr
    if asr is None:
        raise HTTPException(503, "speech-to-text model not loaded")
    try:
        audio = decode(data)
    except BadAudio as error:
        raise HTTPException(400, "audio could not be decoded") from error
    if audio.size < MIN_CLIP_SECONDS * SAMPLE_RATE:
        raise HTTPException(422, "audio too short")
    audio = audio[: int(MAX_CLIP_SECONDS * SAMPLE_RATE)]
    notes: list[str] = []
    if rms(audio) < QUIET_RMS:
        notes.append("audio very quiet")

    result: dict[str, Any] = {
        "text": "",
        "words": [],
        "low_confidence_words": [],
        "nbest": [],
        "duration_seconds": round(audio.size / SAMPLE_RATE, 3),
    }
    # Trim once: the speech spans joined. No speech (or under 0.2 s of it) runs neither decode.
    spans = speech_spans(audio)
    if spans and sum(end - start for start, end in spans) >= MIN_SPEECH_SECONDS * SAMPLE_RATE:
        trimmed = np.concatenate([audio[start:end] for start, end in spans])
        prompt = keyterm_prompt(parse_keyterms(keyterms), asr.count_tokens) or None
        with asr_lock:
            text, words = asr.transcribe(trimmed, initial_prompt=prompt, **MAIN_DECODE)
            try:
                # a few more hypotheses than asked, because some differ only by spaces (P2)
                count = max(nbest + 3, 5)
                hypotheses = asr.nbest(trimmed, prompt=prompt, beam_size=count, num_hypotheses=count, **NBEST_DECODE)
                entries: list[dict[str, Any]] = []
                for hypothesis, score in hypotheses:
                    hypothesis = hypothesis.strip()
                    if hypothesis and all(entry["text"] != hypothesis for entry in entries):
                        entries.append({"text": hypothesis, "score": round(float(score), 4)})
                entries = entries[:nbest]
            except Exception as error:  # the best transcript stays usable without its alternatives
                log.warning("n-best failed: %s", error)
                entries = [{"text": text, "score": None}] if text else []
                notes.append(f"n-best failed ({type(error).__name__}); best transcript only")
        result["text"] = text
        result["words"] = words
        result["low_confidence_words"] = [
            word
            for word in words
            if word.get("probability") is not None and word["probability"] < low_confidence_below
        ]
        result["nbest"] = entries
    result["processing_ms"] = round((time.perf_counter() - started) * 1000)
    result["note"] = "; ".join(notes) or None
    return result


# ---------------------------------------------------------------------------------------------- text-to-speech


def voice_description(voice: str) -> str:
    speaker = VOICES[voice]
    return (
        f"{speaker} speaks in a clear, natural and friendly voice at a moderate pace. "
        "The recording is of very high quality, with the voice sounding clear and very close up."
    )


def to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, np.asarray(samples, dtype=np.float32), sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def to_mp3(wav: bytes) -> bytes:
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"]
    command += ["-ac", "1", "-ar", "22050", "-b:a", "32k", "-f", "mp3", "pipe:1"]
    return subprocess.run(command, input=wav, capture_output=True, check=True).stdout


def cached(key: tuple[str, str, str]) -> bytes | None:
    with cache_lock:
        clip = tts_cache.get(key)
        if clip is not None:
            tts_cache.move_to_end(key)
        return clip


def remember(key: tuple[str, str, str], clip: bytes) -> None:
    with cache_lock:
        tts_cache[key] = clip
        tts_cache.move_to_end(key)
        while len(tts_cache) > TTS_CACHE_SIZE:
            tts_cache.popitem(last=False)


def speak(text: str, voice: str, audio_format: str) -> tuple[bytes, bool]:
    """The clip and whether it came from the cache (keyed by text, voice and format)."""
    key = (text, voice, audio_format)
    clip = cached(key)
    if clip is not None:
        return clip, True
    wav = cached((text, voice, "wav"))
    if wav is None:
        tts = state.tts
        if tts is None:
            raise HTTPException(503, "text-to-speech model not loaded")
        with tts_lock:
            samples, sample_rate = tts.synthesize(text, voice_description(voice))
        wav = to_wav(samples, sample_rate)
    clip = to_mp3(wav) if audio_format == "mp3" else wav
    remember(key, clip)
    return clip, False


# ---------------------------------------------------------------------------------------------- real models


class WhisperAsr:
    """faster-whisper for the main decode; the CTranslate2 model underneath for the N-best decode."""

    def __init__(self, model_dir: str, device: str, compute_type: str) -> None:
        from faster_whisper import WhisperModel
        from faster_whisper.tokenizer import Tokenizer

        self.model = WhisperModel(model_dir, device=device, compute_type=compute_type)
        self.tokenizer = Tokenizer(
            self.model.hf_tokenizer, self.model.model.is_multilingual, task="transcribe", language="bn"
        )

    def count_tokens(self, text: str) -> int:
        return len(self.tokenizer.encode(" " + text.strip()))  # as faster-whisper encodes an initial prompt

    def transcribe(
        self, audio: np.ndarray, *, initial_prompt: str | None, **options: Any
    ) -> tuple[str, list[dict[str, Any]]]:
        segments, _info = self.model.transcribe(audio, initial_prompt=initial_prompt, **options)
        # A clip of at most 30 s is one window, so the first segment is the decode of the whole clip. Later segments
        # come only from decoding again after the last aligned word, where the model invents words (P2); the
        # generator is lazy, so stopping here also skips that decode.
        first = next(iter(segments), None)
        if first is None:
            return "", []
        words = [
            {
                "word": word.word.strip(),
                "start": round(word.start, 3),
                "end": round(word.end, 3),
                "probability": round(word.probability, 4),
            }
            for word in first.words or []
        ]
        return first.text.strip(), words

    def nbest(self, audio: np.ndarray, *, prompt: str | None, **options: Any) -> list[tuple[str, float]]:
        from faster_whisper.audio import pad_or_trim

        extractor = self.model.feature_extractor
        features = extractor(audio)
        encoder_output = self.model.encode(pad_or_trim(features[:, : extractor.nb_max_frames]))
        tokens: list[int] = []
        if prompt:  # the same prompt tokens as the main decode
            tokens = [self.tokenizer.sot_prev, *self.tokenizer.encode(" " + prompt.strip())]
        tokens += [*self.tokenizer.sot_sequence, self.tokenizer.no_timestamps]
        result = self.model.model.generate(encoder_output, [tokens], **options)[0]
        return [
            (self.tokenizer.decode(ids), float(score))
            for ids, score in zip(result.sequences_ids, result.scores, strict=True)
        ]


class ParlerTts:
    def __init__(self, model_id: str, revision: str, fp16: bool, token: str | None) -> None:
        import torch
        from parler_tts import ParlerTTSForConditionalGeneration
        from transformers import AutoTokenizer

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if fp16 and self.device == "cuda" else torch.float32
        self.model = ParlerTTSForConditionalGeneration.from_pretrained(
            model_id, revision=revision, torch_dtype=dtype, token=token
        ).to(self.device)
        self.prompt_tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision, token=token)
        self.description_tokenizer = AutoTokenizer.from_pretrained(self.model.config.text_encoder._name_or_path)
        self.sample_rate = int(self.model.config.sampling_rate)

    def synthesize(self, text: str, description: str) -> tuple[np.ndarray, int]:
        described = self.description_tokenizer(description, return_tensors="pt").to(self.device)
        prompt = self.prompt_tokenizer(text, return_tensors="pt").to(self.device)
        with self.torch.inference_mode():
            generation = self.model.generate(
                input_ids=described.input_ids,
                attention_mask=described.attention_mask,
                prompt_input_ids=prompt.input_ids,
                prompt_attention_mask=prompt.attention_mask,
            )
        return generation.to(self.torch.float32).cpu().numpy().squeeze(), self.sample_rate


def load_models() -> None:
    import ctranslate2

    cuda = ctranslate2.get_cuda_device_count() > 0
    device = "cuda" if cuda else "cpu"
    compute_type = os.environ.get("ASR_COMPUTE_TYPE") or ("float16" if cuda else "int8")
    started = time.perf_counter()
    log.info("loading speech-to-text from %s on %s (%s)", ASR_MODEL_DIR, device, compute_type)
    state.asr = WhisperAsr(ASR_MODEL_DIR, device, compute_type)
    log.info("speech-to-text loaded in %.1f s", time.perf_counter() - started)
    started = time.perf_counter()
    state.tts = ParlerTts(
        TTS_MODEL_ID, TTS_MODEL_REVISION, os.environ.get("TTS_FP16") == "1", os.environ.get("HF_TOKEN") or None
    )
    log.info("text-to-speech loaded in %.1f s", time.perf_counter() - started)
    state.device = device


def warm_up() -> None:
    """Builds the VAD session and puts the fixed phrases into the cache, in the format the server asks for."""
    started = time.perf_counter()
    if state.asr is not None:
        silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
        state.asr.transcribe(silence, initial_prompt=None, **MAIN_DECODE)
    if state.tts is not None:
        for voice in VOICES:
            for phrase in WARM_PHRASES:
                speak(phrase, voice, "mp3")
    log.info("warm-up done in %.1f s", time.perf_counter() - started)


def prepare() -> None:
    """Converts the speech-to-text model to CTranslate2 and downloads the text-to-speech weights (run once)."""
    from ctranslate2.converters import TransformersConverter
    from huggingface_hub import snapshot_download
    from parler_tts import ParlerTTSConfig
    from transformers import AutoTokenizer, WhisperFeatureExtractor, WhisperTokenizerFast

    token = os.environ.get("HF_TOKEN") or None
    source = snapshot_download(ASR_HF_ID, revision=ASR_HF_REVISION, token=token)
    TransformersConverter(source).convert(ASR_MODEL_DIR, quantization="float16", force=True)
    try:
        tokenizer = WhisperTokenizerFast.from_pretrained(source)
        extractor = WhisperFeatureExtractor.from_pretrained(source)
    except (OSError, ValueError):
        name, revision = WHISPER_FALLBACK
        log.warning("model repository lacks the tokenizer or feature extractor: using %s", name)
        tokenizer = WhisperTokenizerFast.from_pretrained(name, revision=revision)
        extractor = WhisperFeatureExtractor.from_pretrained(name, revision=revision)
    tokenizer.save_pretrained(ASR_MODEL_DIR)
    extractor.save_pretrained(ASR_MODEL_DIR)
    snapshot_download(TTS_MODEL_ID, revision=TTS_MODEL_REVISION, token=token)
    config = ParlerTTSConfig.from_pretrained(TTS_MODEL_ID, revision=TTS_MODEL_REVISION, token=token)
    AutoTokenizer.from_pretrained(config.text_encoder._name_or_path)  # the description tokenizer, into the cache
    log.info("prepared %s and %s", ASR_MODEL_DIR, TTS_MODEL_ID)


# ---------------------------------------------------------------------------------------------- the API


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    if os.environ.get("SPEECH_LOAD_MODELS", "1") != "0":
        load_models()  # before the port opens
        warm_up()
    state.ready = True
    yield


api = FastAPI(title="DokaanBondhu speech worker", lifespan=lifespan)


@api.middleware("http")
async def require_api_key(request: Request, call_next: Callable[[Request], Any]) -> Any:
    key = os.environ.get("SPEECH_API_KEY", "")
    if key:
        sent = request.headers.get("x-api-key", "")
        if not hmac.compare_digest(sent.encode(), key.encode()):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


@api.post("/asr")
def asr_endpoint(
    audio: UploadFile = File(...),
    keyterms: str = Form(""),
    nbest: int = Form(5, ge=1, le=10),
    low_confidence_below: float = Form(0.5, ge=0, le=1),
) -> dict[str, Any]:
    return transcribe_clip(audio.file.read(), keyterms, nbest, low_confidence_below)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    voice: str = "aditi"
    format: Literal["wav", "mp3"] = "wav"


@api.post("/tts")
def tts_endpoint(body: TtsRequest) -> Response:
    if body.voice not in VOICES:
        raise HTTPException(400, f"unknown voice: {body.voice}")
    started = time.perf_counter()
    clip, hit = speak(body.text, body.voice, body.format)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    headers = {"X-Cache": "hit" if hit else "miss", "X-Processing-Ms": str(elapsed_ms)}
    media_type = "audio/mpeg" if body.format == "mp3" else "audio/wav"
    return Response(content=clip, media_type=media_type, headers=headers)


@api.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok" if state.ready else "loading",
        "version": SPEECH_VERSION,
        "device": state.device,
        "asr_model": ASR_HF_ID,
        "tts_model": TTS_MODEL_ID,
        "voices": list(VOICES),
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if sys.argv[1:] == ["prepare"]:
        prepare()
    else:
        print("usage: python speech_app.py prepare")
        sys.exit(2)
