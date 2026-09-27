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
        "beam_size": 5,
        "num_hypotheses": 3,
        "return_scores": True,
        "max_length": 448,
        "suppress_blank": True,
        "repetition_penalty": 1.1,
        "no_repeat_ngram_size": 3,
    }


def test_a_clip_without_speech_runs_neither_decode(client, fake_asr: FakeAsr) -> None:
    response = client.post("/asr", files={"audio": ("clip.wav", clip("no_speech.wav"), "audio/wav")})
    assert response.status_code == 200
    body = response.json()
    assert body["text"] == ""
    assert body["words"] == []
    assert body["nbest"] == []
    assert fake_asr.transcribe_calls == []
    assert fake_asr.nbest_calls == []
