import * as Haptics from "expo-haptics";

// A short vibration (spec D166): when the talk button is pressed and let go, and on Yes. A phone without a vibrator,
// or one with vibration off, simply does nothing.

export function buzz(kind: "press" | "release" | "success"): void {
  const done =
    kind === "success"
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(
          kind === "press" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
        );
  done.catch(() => undefined);
}
