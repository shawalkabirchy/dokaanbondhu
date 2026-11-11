"""The speech worker on Modal, for development (spec 14.1).

Once:   modal run modal_app.py::prepare_models   (converts and downloads the models into the volume)
Deploy: modal deploy modal_app.py               (an L4, else an A10G when no L4 is free, D238)
        on an L40S instead of the L4 (the capstone day, D192, D205), in PowerShell:
        $env:SPEECH_GPU = "L40S"; modal deploy modal_app.py   (an L40S, else an L4, else an A10G)
Every request needs a Modal proxy token (headers Modal-Key and Modal-Secret).
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent

# Read when deploying; the container gets the same value, so both see one GPU list (D205).
GPU = os.environ.get("SPEECH_GPU") or "L4"
if GPU not in ("L4", "L40S"):
    raise SystemExit(f"SPEECH_GPU is L4 or L40S, not {GPU!r}")
# Modal starts the first type in the list that it has free (D238): on 11 Nov it started no L40S and then, for a while,
# no L4, so voice stopped. An A10G ($1.10 an hour against the L4's $0.80) is as able for both models (24 GB, half
# precision) and is taken only when the chosen GPU is not free.
GPUS = ["L40S", "L4", "A10G"] if GPU == "L40S" else ["L4", "A10G"]

app = modal.App("dokaanbondhu-speech")
models = modal.Volume.from_name("dokaanbondhu-speech-models", create_if_missing=True)
huggingface = modal.Secret.from_name("huggingface")  # HF_TOKEN: Indic Parler-TTS is gated

image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .apt_install("git", "ffmpeg")
    .pip_install_from_requirements(str(HERE / "requirements.txt"))
    .env({"HF_HOME": "/models/hf", "ASR_MODEL_DIR": "/models/tugstugi-ct2", "TTS_FP16": "1"})
    .add_local_file(HERE / "speech_app.py", "/root/speech_app.py")
)


@app.function(image=image, volumes={"/models": models}, secrets=[huggingface], memory=16_384, timeout=45 * 60)
def prepare_models() -> None:
    import speech_app

    speech_app.prepare()
    models.commit()


@app.function(
    image=image,
    gpu=GPUS,
    env={"SPEECH_GPU": GPU},
    volumes={"/models": models},
    secrets=[huggingface],
    scaledown_window=5 * 60,  # scales to zero after 5 idle minutes; awake.py keeps one running (D205)
    startup_timeout=15 * 60,  # loading both models and the warm-up
    routing_region="ap-south",  # the entry point closest to Bangladesh; no container region (D63)
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app(requires_proxy_auth=True)
def serve():  # type: ignore[no-untyped-def]
    from speech_app import api

    return api
