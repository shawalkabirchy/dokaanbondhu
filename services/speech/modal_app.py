"""The speech worker on Modal, for development (spec 14.1).

Once:   modal run modal_app.py::prepare_models   (converts and downloads the models into the volume)
Deploy: modal deploy modal_app.py
Every request needs a Modal proxy token (headers Modal-Key and Modal-Secret).
"""

from __future__ import annotations

from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent

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
    gpu="L4",
    volumes={"/models": models},
    secrets=[huggingface],
    scaledown_window=5 * 60,  # scales to zero after 5 idle minutes
    startup_timeout=15 * 60,  # loading both models and the warm-up
    routing_region="ap-south",  # the entry point closest to Bangladesh; no container region (D63)
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app(requires_proxy_auth=True)
def serve():  # type: ignore[no-untyped-def]
    from speech_app import api

    return api
