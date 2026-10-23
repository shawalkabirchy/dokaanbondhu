import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { create } from "zustand";
import type { PlayerDeps } from "./reply-player";

// The phone's side of spoken replies (spec 15.3, 15.4): MP3 files in the cache folder played with expo-audio, one at
// a time, and the bundled "abar bolben" clip, which plays without the server.

let current: { player: AudioPlayer; finish: () => void } | null = null;

/** Whether an answer is being spoken now, for the assistant page's "বলছি…" and its stop button (D166). */
export const usePlayback = create<{ playing: boolean }>(() => ({ playing: false }));

function playSource(source: string | number): Promise<void> {
  return new Promise((resolve) => {
    const player = createAudioPlayer(source);
    const finish = () => {
      subscription.remove();
      player.remove();
      if (current?.player === player) {
        current = null;
        usePlayback.setState({ playing: false });
      }
      resolve();
    };
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) finish();
    });
    current = { player, finish };
    usePlayback.setState({ playing: true });
    player.play();
  });
}

/** Stops whatever is playing now (barge-in). */
export function stopPlayback(): void {
  if (!current) return;
  current.player.pause();
  current.finish();
}

export const phonePlayer: PlayerDeps = {
  save: (name, bytes) => {
    const file = new File(Paths.cache, name);
    file.create({ overwrite: true });
    file.write(bytes);
    return file.uri;
  },
  play: (uri) => playSource(uri),
  stopPlaying: stopPlayback,
  remove: (uri) => new File(uri).delete(),
};

/**
 * Until D204 the recorder also saved each recording as a WAV file in the app's documents, which nothing read and
 * nothing deleted; the app keeps no WAV files of its own, so any found there are removed.
 */
export function removeOldRecordings(): void {
  try {
    for (const entry of Paths.document.list())
      if (entry instanceof File && entry.name.endsWith(".wav")) entry.delete();
  } catch {
    // nothing to tidy, or the folder cannot be read: recording works either way
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ASK_AGAIN_CLIP = require("../../assets/audio/abar-bolben.mp3") as number;

/** "আবার বলবেন?", bundled in the app (spec 15.3). */
export function playAskAgain(): void {
  stopPlayback();
  void playSource(ASK_AGAIN_CLIP);
}
