"""Shared test setup: no models are loaded (SPEECH_LOAD_MODELS=0); fakes record every call instead (spec 14.1)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

os.environ["SPEECH_LOAD_MODELS"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import speech_app  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"


class FakeAsr:
    """Stands in for the Whisper model: records the audio and the decode settings of every call."""

    def __init__(self) -> None:
        self.transcribe_calls: list[dict[str, Any]] = []
        self.nbest_calls: list[dict[str, Any]] = []
        self.nbest_error: Exception | None = None
        self.hypotheses: list[tuple[str, float]] = [
            ("এক্সিও ২০১৪ সামনের প্যাড", -0.21),
            ("এক্সিও ২০১৪ সামনের প্যাড", -0.35),  # repeated: dropped
            ("  ", -0.9),  # empty: dropped
            ("এক্সিও ২০১৪ সামনের প্যাডটা", -0.42),
        ]

    def count_tokens(self, text: str) -> int:
        return len(text.split())

    def transcribe(
        self, audio: np.ndarray, *, initial_prompt: str | None, **options: Any
    ) -> tuple[str, list[dict[str, Any]]]:
        self.transcribe_calls.append({"audio": audio.copy(), "initial_prompt": initial_prompt, **options})
        words = [
            {"word": "এক্সিও", "start": 0.0, "end": 0.5, "probability": 0.93},
            {"word": "২০১৪", "start": 0.5, "end": 1.1, "probability": 0.41},
            {"word": "সামনের", "start": 1.1, "end": 1.6, "probability": 0.88},
            {"word": "প্যাড", "start": 1.6, "end": 2.0, "probability": 0.62},
        ]
        return "এক্সিও ২০১৪ সামনের প্যাড", words

    def nbest(self, audio: np.ndarray, *, prompt: str | None, **options: Any) -> list[tuple[str, float]]:
        self.nbest_calls.append({"audio": audio.copy(), "prompt": prompt, **options})
        if self.nbest_error is not None:
            raise self.nbest_error
        return self.hypotheses


class FakeTts:
    """A one-second 440 Hz tone at Parler-TTS's 44.1 kHz."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def synthesize(self, text: str, description: str) -> tuple[np.ndarray, int]:
        self.calls.append((text, description))
        rate = 44_100
        t = np.arange(rate) / rate
        return (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32), rate


@pytest.fixture
def fake_asr() -> FakeAsr:
    fake = FakeAsr()
    speech_app.state.asr = fake
    return fake


@pytest.fixture
def fake_tts() -> FakeTts:
    fake = FakeTts()
    speech_app.state.tts = fake
    speech_app.tts_cache.clear()
    return fake


@pytest.fixture
def client(fake_asr: FakeAsr, fake_tts: FakeTts, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    from fastapi.testclient import TestClient

    monkeypatch.delenv("SPEECH_API_KEY", raising=False)
    with TestClient(speech_app.api) as test_client:
        yield test_client


def clip(name: str) -> bytes:
    return (DATA / name).read_bytes()
