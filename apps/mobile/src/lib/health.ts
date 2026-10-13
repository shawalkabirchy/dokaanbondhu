import { healthSchema, type Health } from "@dokaanbondhu/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { api } from "./api";
import { useDeviceSettings } from "./settings-store";

// GET /health at start, when the app comes to the foreground, and every 60 s (spec 15.7). While status is not "ok"
// the microphone is off. For 2 minutes after the app opens or comes to the foreground, a server that does not answer
// may be waking (Render's free plan takes about a minute): the app asks every 5 s and says "starting", and says
// "offline" only after that, or when a server that had answered stops answering (D164). Speech "down" only shows a
// warning: the button still works, so a press tries again and a success clears it (D111). Speech "waking" is asked
// every 10 s; the signed-in app wakes the speech worker once the server answers and on each return to the
// foreground (D164).

export const START_MS = 120_000;
const START_POLL_MS = 5_000;
const WAKING_POLL_MS = 10_000;
const POLL_MS = 60_000;

export async function fetchHealth(serverUrl: string): Promise<Health> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${serverUrl}/api/v1/health`, { signal: controller.signal });
    return healthSchema.parse(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

const DOWN: Health = { status: "down", version: "", db: "down", speech: "unknown", llm: "unknown" };

/** Since when a server that does not answer may be waking, and whether it has answered since (D164). */
const opened = { at: Date.now(), answered: false };

/** The app opened or came to the foreground: the server may have gone to sleep meanwhile. */
export function markOpened(now = Date.now()): void {
  opened.at = now;
  opened.answered = false;
}

interface Checked {
  health: Health;
  /** Not answering yet, within 2 minutes of the start: the server may be waking (D164). */
  starting: boolean;
}

async function check(serverUrl: string): Promise<Checked> {
  const answer = (health: Health): Checked => {
    if (health.status === "ok") opened.answered = true;
    return {
      health,
      starting: health.status !== "ok" && !opened.answered && Date.now() - opened.at < START_MS,
    };
  };
  const first = await fetchHealth(serverUrl).catch(() => DOWN);
  const result = answer(first);
  if (first.status === "ok" || result.starting) return result; // while starting it is asked again in 5 s anyway
  // One slow check (the platform DB answering after 3 s) should not show "offline": ask once more 2 s later (D82).
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return answer(await fetchHealth(serverUrl).catch(() => DOWN));
}

export function useHealth() {
  const serverUrl = useDeviceSettings((state) => state.serverUrl);
  const query = useQuery({
    queryKey: ["health", serverUrl],
    queryFn: () => check(serverUrl),
    staleTime: POLL_MS,
    refetchInterval: (current) => {
      const data = current.state.data;
      if (data?.starting) return START_POLL_MS;
      if (data?.health.status === "ok" && data.health.speech === "waking") return WAKING_POLL_MS;
      return POLL_MS;
    },
  });
  const { refetch } = query;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      markOpened();
      void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);
  const health = query.data?.health ?? DOWN;
  const online = health.status === "ok";
  return {
    health,
    online,
    starting: query.data?.starting ?? false,
    micAllowed: online,
    speechTrouble: online && health.speech === "down",
    speechWaking: online && health.speech === "waking",
    checking: query.isLoading,
    refresh: refetch,
  };
}

/** Asks the server to wake the speech worker (D164), then checks health so "getting ready" shows at once. */
export async function wakeSpeech(refresh: () => unknown): Promise<void> {
  try {
    await api("/speech/wake", { method: "POST" });
  } catch {
    // the next health check says how speech is
  }
  void refresh();
}

/** For the signed-in app: wakes the speech worker once the server answers, and on each return to the foreground. */
export function useSpeechWake(signedIn: boolean): void {
  const { online, refresh } = useHealth();
  useEffect(() => {
    if (!signedIn || !online) return;
    void wakeSpeech(refresh);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void wakeSpeech(refresh);
    });
    return () => subscription.remove();
  }, [signedIn, online, refresh]);
}
