import type { StoredProviderRow } from "./chain";
import { markSpeechWaking, recordProviderCall, speechHealth, type SpeechHealth } from "./health";
import type { ProviderJob } from "./select";
import { speechWorkerWake } from "./speech";

// Waking the speech worker (spec 8.3, 13.4, D164): Modal scales it to zero after 5 idle minutes and takes up to 360 s
// to start again, so the app asks for a wake when it opens and every 4 minutes while the voice page is in front. The
// worker's own GET /health starts it. One wake runs at a time, kept on globalThis like the health results; a call
// while one runs waits on that one.

const WAIT_MS = 2000;

const holder = globalThis as { __dokaanSpeechWake?: Promise<void> | null };

/**
 * Wakes the speech worker behind the shop's stt and tts rows and answers the speech state within `waitMs`: "ok" when
 * the worker answered by then, "waking" while it starts. A wake while speech is already "ok" only keeps the worker
 * awake and never shows "waking". Rows that are not the speech worker have nothing to wake.
 */
export async function wakeSpeech(
  used: { stt: StoredProviderRow | null; tts: StoredProviderRow | null },
  aesKey: Buffer,
  waitMs = WAIT_MS,
): Promise<SpeechHealth> {
  if (!holder.__dokaanSpeechWake) {
    const workers = new Map<string, { wake: () => Promise<boolean>; jobs: ProviderJob[] }>();
    for (const job of ["stt", "tts"] as const) {
      const row = used[job];
      const worker = row ? speechWorkerWake(row, aesKey) : null;
      if (!worker) continue;
      const known = workers.get(worker.address);
      if (known) known.jobs.push(job);
      else workers.set(worker.address, { wake: worker.wake, jobs: [job] });
    }
    if (workers.size === 0) return speechHealth();
    markSpeechWaking(speechHealth() !== "ok");
    holder.__dokaanSpeechWake = Promise.all(
      [...workers.values()].map(async ({ wake, jobs }) => {
        const ok = await wake();
        for (const job of jobs) recordProviderCall(job, ok);
      }),
    )
      .then(() => undefined)
      .finally(() => {
        markSpeechWaking(false);
        holder.__dokaanSpeechWake = null;
      });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    holder.__dokaanSpeechWake,
    new Promise((resolve) => (timer = setTimeout(resolve, waitMs))),
  ]);
  clearTimeout(timer);
  return speechHealth();
}
