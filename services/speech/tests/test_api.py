"""The /asr contract (the server's AsrResult, spec 13.1), errors, the API key, /tts with MP3 and /health."""

from __future__ import annotations

import io

import numpy as np
import pytest
import soundfile as sf
from conftest import FakeAsr, FakeTts, clip

import speech_app


def wav_bytes(samples: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, samples.astype(np.float32), speech_app.SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def test_asr_answer_has_the_contract_shape(client) -> None:
    response = client.post(
        "/asr",
        files={"audio": ("clip.wav", clip("speech_with_silence.wav"), "audio/wav")},
        data={"nbest": "5", "low_confidence_below": "0.5"},
    )
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "text",
        "words",
        "low_confidence_words",
        "nbest",
        "duration_seconds",
        "processing_ms",
        "note",
    }
    assert body["text"] == "এক্সিও ২০১৪ সামনের প্যাড"
    for word in body["words"]:
        assert set(word) == {"word", "start", "end", "probability"}
    assert [word["word"] for word in body["low_confidence_words"]] == ["২০১৪"]
    assert set(body["low_confidence_words"][0]) == {"word", "start", "end", "probability"}
    # empty and repeated hypotheses are dropped
    assert [entry["text"] for entry in body["nbest"]] == ["এক্সিও ২০১৪ সামনের প্যাড", "এক্সিও ২০১৪ সামনের প্যাডটা"]
    assert all(isinstance(entry["score"], float) for entry in body["nbest"])
    assert body["duration_seconds"] == pytest.approx(6.69, abs=0.01)
    assert isinstance(body["processing_ms"], int)
    assert body["note"] is None


def test_nbest_failure_keeps_the_best_transcript(client, fake_asr: FakeAsr) -> None:
    fake_asr.nbest_error = RuntimeError("out of memory")
    body = client.post("/asr", files={"audio": ("clip.wav", clip("speech_with_silence.wav"), "audio/wav")}).json()
    assert body["nbest"] == [{"text": "এক্সিও ২০১৪ সামনের প্যাড", "score": None}]
    assert "n-best failed" in body["note"]


def test_quiet_audio_is_noted(client) -> None:
    quiet = wav_bytes(speech_app.decode(clip("speech_with_silence.wav")) * 0.05)
    body = client.post("/asr", files={"audio": ("clip.wav", quiet, "audio/wav")}).json()
    assert "audio very quiet" in body["note"]


def test_asr_errors(client) -> None:
    bad = client.post("/asr", files={"audio": ("clip.wav", b"not audio at all", "audio/wav")})
    assert bad.status_code == 400
    short = client.post("/asr", files={"audio": ("clip.wav", wav_bytes(np.zeros(3_200)), "audio/wav")})
    assert short.status_code == 422
    assert short.json()["detail"] == "audio too short"
    too_many = client.post(
        "/asr",
        files={"audio": ("clip.wav", clip("speech_with_silence.wav"), "audio/wav")},
        data={"nbest": "11"},
    )
    assert too_many.status_code == 422


def test_a_clip_over_30_s_is_cut(client, fake_asr: FakeAsr) -> None:
    long = wav_bytes(np.tile(speech_app.decode(clip("speech_with_silence.wav")), 6))  # about 40 s
    body = client.post("/asr", files={"audio": ("clip.wav", long, "audio/wav")}).json()
    assert body["duration_seconds"] == 30.0


def test_keyterm_prompt_stops_before_80_tokens() -> None:
    terms = [f"term{i}" for i in range(200)]
    prompt = speech_app.keyterm_prompt(terms, lambda text: len(text.split()))
    assert len(prompt.split()) == 80
    assert speech_app.parse_keyterms("Axio, B-3\nAxio,, brake pad ") == ["Axio", "B-3", "brake pad"]


def test_api_key_is_required_when_set(client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SPEECH_API_KEY", "test-key")
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get("/health", headers={"X-API-Key": "test-key"}).status_code == 200


def test_tts_mp3_is_22_khz_mono_and_cached(client, fake_tts: FakeTts) -> None:
    request = {"text": "হয়ে গেছে।", "voice": "arjun", "format": "mp3"}
    first = client.post("/tts", json=request)
    assert first.status_code == 200
    assert first.headers["content-type"] == "audio/mpeg"
    assert first.headers["x-cache"] == "miss"
    assert int(first.headers["x-processing-ms"]) >= 0
    info = sf.info(io.BytesIO(first.content))
    assert (info.samplerate, info.channels) == (22_050, 1)
    assert fake_tts.calls[0][1].startswith("Arjun speaks in a clear, natural and friendly voice")
    second = client.post("/tts", json=request)
    assert second.headers["x-cache"] == "hit"
    assert second.content == first.content
    assert len(fake_tts.calls) == 1


def test_tts_wav_by_default_and_unknown_voice(client) -> None:
    wav = client.post("/tts", json={"text": "ঠিক আছে?"})
    assert wav.headers["content-type"] == "audio/wav"
    info = sf.info(io.BytesIO(wav.content))
    assert (info.samplerate, info.channels, info.subtype) == (44_100, 1, "PCM_16")
    assert client.post("/tts", json={"text": "ঠিক আছে?", "voice": "nobody"}).status_code == 400
    assert client.post("/tts", json={"text": ""}).status_code == 422


def test_health(client) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["voices"] == ["aditi", "arjun"]
    assert set(body) == {"status", "version", "device", "asr_model", "tts_model", "voices"}
