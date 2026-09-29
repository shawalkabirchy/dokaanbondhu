import { ReplyPlayer, type PlayerDeps } from "./reply-player";

// Spoken replies (spec 15.4, 15.8): audio plays strictly in seq order, a press stops it (barge-in), and the turn's
// files are deleted once they have played.

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function setup() {
  const played: string[] = [];
  const removed: string[] = [];
  let finishCurrent: (() => void) | null = null;
  const deps: PlayerDeps = {
    save: (name, bytes) => `file://${name}#${Buffer.from(bytes).toString("utf8")}`,
    play: (uri) =>
      new Promise<void>((resolve) => {
        played.push(uri.split("#")[1]!);
        finishCurrent = resolve;
      }),
    stopPlaying: () => finishCurrent?.(),
    remove: (uri) => removed.push(uri.split("#")[1]!),
  };
  const finishPlaying = async () => {
    const finish = finishCurrent;
    finishCurrent = null;
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { player: new ReplyPlayer(deps, "t1"), played, removed, finishPlaying };
}

describe("reply player", () => {
  it("plays the sentences in seq order, even when a later one is ready first", async () => {
    const { player, played, finishPlaying } = setup();
    player.add(1, b64("second"));
    expect(played).toEqual([]); // waits for seq 0
    player.add(0, b64("first"));
    expect(played).toEqual(["first"]);
    await finishPlaying();
    expect(played).toEqual(["first", "second"]);
  });

  it("deletes the turn's files once the last sentence has played", async () => {
    const { player, removed, finishPlaying } = setup();
    player.add(0, b64("only"));
    player.end();
    expect(removed).toEqual([]); // still playing
    await finishPlaying();
    expect(removed).toEqual(["only"]);
  });

  it("stops at once on a new press and plays nothing more of the turn", async () => {
    const { player, played, removed } = setup();
    player.add(0, b64("first"));
    player.stop();
    player.add(1, b64("second"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(played).toEqual(["first"]);
    expect(removed).toEqual(["first"]);
  });
});
