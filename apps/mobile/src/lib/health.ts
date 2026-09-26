import { healthSchema, type Health } from "@dokaanbondhu/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useDeviceSettings } from "./settings-store";

// GET /health at start, when the app comes to the foreground, and at most every 60 s (spec 15.7). While status is
// not "ok" the app shows the offline banner and turns the microphone off; speech "down" turns off only the microphone.

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

export function useHealth() {
  const serverUrl = useDeviceSettings((state) => state.serverUrl);
  const query = useQuery({
    queryKey: ["health", serverUrl],
    queryFn: () => fetchHealth(serverUrl).catch(() => DOWN),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const { refetch } = query;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refetch();
    });
    return () => subscription.remove();
  }, [refetch]);
  const health = query.data ?? DOWN;
  return {
    health,
    online: health.status === "ok",
    micAllowed: health.status === "ok" && health.speech !== "down",
    checking: query.isLoading,
  };
}
