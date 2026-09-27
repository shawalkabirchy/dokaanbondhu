"""The three trim tests of the architecture document (hallucination control, D53): the Whisper model is a fake
that records the audio and settings of every call; the VAD is faster-whisper's real Silero VAD."""

from __future__ import annotations

import numpy as np
from conftest import FakeAsr, clip

import speech_app


def test_nbest_receives_the_same_trimmed_clip_as_the_main_decode(client, fake_asr: FakeAsr) -> None:
    original = speech_app.decode(clip("speech_with_silence.wav"))
    response = client.post("/asr", files={"audio": ("clip.wav", clip("speech_with_silence.wav"), "audio/wav")})
    assert response.status_code == 200
    assert len(fake_asr.transcribe_calls) == 1
    assert len(fake_asr.nbest_calls) == 1
    main_audio = fake_asr.transcribe_calls[0]["audio"]
    nbest_audio = fake_asr.nbest_calls[0]["audio"]
    np.testing.assert_array_equal(nbest_audio, main_audio)
    # trimmed: the 0.8 s of leading silence and most of the 2.5 s tail are gone
    assert main_audio.size < original.size - 2 * speech_app.SAMPLE_RATE
    assert main_audio.size > 3 * speech_app.SAMPLE_RATE


def test_main_decode_has_vad_filter_and_every_quality_gate(client, fake_asr: FakeAsr) -> None:
    client.post(
        "/asr",
        files={"audio": ("clip.wav", clip("speech_with_silence.wav"), "audio/wav")},
        data={"keyterms": "Axio, brake pad\nB-3", "nbest": "3"},
    )
    main = fake_asr.transcribe_calls[0]
    # written out here, not taken from speech_app, so removing a gate there fails this test
    expected = {
        "language": "bn",
        "task": "transcribe",
        "beam_size": 5,
        "word_timestamps": True,
        "without_timestamps": True,
        "condition_on_previous_text": False,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 300, "speech_pad_ms": 200},
        "hallucination_silence_threshold": 0.5,
        "no_speech_threshold": 0.6,
        "compression_ratio_threshold": 2.2,
        "log_prob_threshold": -1.0,
        "repetition_penalty": 1.1,
        "no_repeat_ngram_size": 3,
        "temperature": [0.0, 0.2, 0.4],
    }
    assert {key: value for key, value in main.items() if key not in ("audio", "initial_prompt")} == expected
    assert main["initial_prompt"] == "Axio, brake pad, B-3"
    nbest = fake_asr.nbest_calls[0]
    assert nbest["prompt"] == main["initial_prompt"]
    assert {key: value for key, value in nbest.items() if key not in ("audio", "prompt")} == {
        "beam_size": 6,
        "num_hypotheses": 6,
        "return_scores": True,
        "max_length": 448,
        "suppress_blank": True,
        "repetition_penalty": 1.1,
        "no_repeat_ngram_size": 3,
    }


def test_only_the_first_segment_is_kept_and_the_leftover_is_never_decoded() -> None:
    """P2: after the first segment, faster-whisper decodes again from the last aligned word and invents words."""
    from types import SimpleNamespace

    decoded: list[str] = []

    def segments():  # lazy, like faster-whisper's generator
        decoded.append("first")
        word = SimpleNamespace(word=" এক্সিও", start=0.0, end=0.61234, probability=0.912345)
        yield SimpleNamespace(text=" এক্সিও দুই হাজার চৌদ্দ ", words=[word])
        decoded.append("leftover")
        yield SimpleNamespace(text="বিশ্ববিদ্যালয়ের প্রধানমন্ত্রী", words=[])

    asr = speech_app.WhisperAsr.__new__(speech_app.WhisperAsr)
    asr.model = SimpleNamespace(transcribe=lambda audio, **options: (segments(), None))
    text, words = asr.transcribe(np.zeros(16_000, dtype=np.float32), initial_prompt=None)
    assert text == "এক্সিও দুই হাজার চৌদ্দ"
    assert words == [{"word": "এক্সিও", "start": 0.0, "end": 0.612, "probability": 0.9123}]
    assert decoded == ["first"]


def test_a_clip_without_speech_runs_neither_decode(client, fake_asr: FakeAsr) -> None:
    response = client.post("/asr", files={"audio": ("clip.wav", clip("no_speech.wav"), "audio/wav")})
    assert response.status_code == 200
    body = response.json()
    assert body["text"] == ""
    assert body["words"] == []
    assert body["nbest"] == []
    assert fake_asr.transcribe_calls == []
    assert fake_asr.nbest_calls == []
