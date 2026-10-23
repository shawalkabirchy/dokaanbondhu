"""Keeps one speech worker running all day, or lets it sleep again (spec 19.3; D192, D205).

On:     modal run awake.py --mode on       one container kept running (L4 about $0.80 an hour, L40S about $1.95)
Off:    modal run awake.py --mode off      back to none kept: it sleeps after 5 quiet minutes
Status: modal run awake.py                 how many containers run now

It changes Modal's min_containers on the deployed worker, without a redeploy. A redeploy sets it back to none, so
deploy first (modal_app.py, the GPU too), then switch it on.
"""

from __future__ import annotations

import modal

app = modal.App("dokaanbondhu-speech-awake")


@app.local_entrypoint()
def main(mode: str = "status") -> None:
    if mode not in ("on", "off", "status"):
        raise SystemExit("--mode is on, off or status")
    serve = modal.Function.from_name("dokaanbondhu-speech", "serve")
    if mode != "status":
        settings = serve.update_autoscaler(min_containers=1 if mode == "on" else 0)
        print(f"Kept running: {settings.min_containers} container(s)")
    stats = serve.get_current_stats()
    print(f"Running now: {stats.num_total_runners} container(s), {stats.num_running_inputs} request(s) in progress")
    if mode == "on":
        print("A new container needs 1 to 6 minutes before voice is ready. In the evening: modal run awake.py --mode off")
