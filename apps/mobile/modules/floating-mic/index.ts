import { NativeModule, requireOptionalNativeModule } from "expo";

// The floating mic's native side (spec 15.9, D196, D203), Android only: a round mic over other apps, the answer card
// beside it, and the foreground service that lets the app use the microphone while another app is in front. It only
// draws and reports touches; the recording, the upload and the answer are the app's own push-to-talk.

/** Ready, listening (with the voice's loudness), working, the speech worker waking, speaking, or offline. */
export type BubbleMode = "ready" | "listening" | "working" | "waking" | "speaking" | "off";

/** The answer card: its text, and for a write waiting for yes or no, the action and the buttons' words. */
export interface BubbleCard {
  text: string;
  actionId?: string;
  yes?: string;
  no?: string;
}

export interface BubbleLook {
  mode: BubbleMode;
  /** The last chunk's loudness while listening (RMS, 0 to 1). */
  level: number;
  card: BubbleCard | null;
}

/** The notification's channel name, title, text and Stop button, and the bubble's spoken label, in the app's words. */
export interface BubbleLabels {
  name: string;
  title: string;
  text: string;
  stop: string;
  hold: string;
}

type Events = {
  onPressIn: () => void;
  onPressOut: () => void;
  /** The bubble was dragged: the recording that started with the press is dropped. */
  onCancel: () => void;
  onDecide: (event: { actionId: string; decision: "yes" | "no" }) => void;
  /** Switched off from the bubble (the ×) or the notification, or it could not start. */
  onClosed: (event: { error?: string }) => void;
};

declare class FloatingMicModule extends NativeModule<Events> {
  isSupported(): boolean;
  canDrawOverlays(): boolean;
  openOverlaySettings(): void;
  isRunning(): boolean;
  /** Only while the app is in front (Android 14 starts a microphone service only then). */
  start(labels: BubbleLabels): Promise<void>;
  stop(): Promise<void>;
  update(look: BubbleLook): Promise<void>;
}

/** Null where there is no floating mic: iOS, and the tests. */
export const FloatingMic = requireOptionalNativeModule<FloatingMicModule>("FloatingMic");
