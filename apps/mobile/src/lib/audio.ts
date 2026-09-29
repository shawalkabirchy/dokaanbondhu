import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import type { PlayerDeps } from "./reply-player";

// The phone's side of spoken replies (spec 15.3, 15.4): MP3 files in the cache folder played with expo-audio, one at
// a time, and the bundled "abar bolben" clip, which plays without the server.

let current: { player: AudioPlayer; finish: () => void } | null = null;

function playSource(source: string | number): Promise<void> {
  return new Promise((resolve) => {
    const player = createAudioPlayer(source);
    const finish = () => {
      subscription.remove();
      player.remove();
      if (current?.player === player) current = null;
      resolve();
    };
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) finish();
    });
    current = { player, finish };
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ASK_AGAIN_CLIP = require("../../assets/audio/abar-bolben.mp3") as number;

/** "আবার বলবেন?", bundled in the app (spec 15.3). */
export function playAskAgain(): void {
  stopPlayback();
  void playSource(ASK_AGAIN_CLIP);
}
