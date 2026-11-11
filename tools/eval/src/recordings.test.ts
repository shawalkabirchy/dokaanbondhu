import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { itemSchema, type Item } from "./items";
import { cardOfFile, localClips, withTranscript } from "./recordings";

// The speakers' recordings on the laptop and the transcript page's save (D235, D236).

const voice = (id: string, speaker: string): Item =>
  itemSchema.parse({
    id,
    channel: "voice",
    split: "open",
    kind: "other_read",
    task_card: "Ask the due",
    expected: { answer: "see_in_app" },
    speaker,
    audio: `recordings/<shop_id>/eval/${id}.wav`,
    reference_transcript: "",
  });

describe("recordings", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("reads a card code however a phone wrote it", () => {
    expect(cardOfFile("V-005.m4a")).toBe("v-005");
    expect(cardOfFile("v106.mp3")).toBe("v-106");
    expect(cardOfFile("v_042 .wav")).toBe("v-042");
    expect(cardOfFile("v-7.m4a")).toBe("v-007");
    expect(cardOfFile("New Recording 12.m4a")).toBeNull();
    expect(cardOfFile("v-1000.m4a")).toBeNull();
  });

  it("uses a file only on its own speaker's sheet, and names what is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    dirs.push(dir);
    mkdirSync(join(dir, "S3"));
    mkdirSync(join(dir, "S1"));
    for (const name of ["V-005.m4a", "v-006.mp3", "v-007.m4a", "notes.txt", "Recording 3.m4a"])
      writeFileSync(join(dir, "S3", name), "x");
    const items = [
      voice("v-005", "S3"),
      voice("v-006", "S3"),
      voice("v-014", "S3"),
      voice("v-007", "S4"),
      voice("v-001", "S1"),
    ];
    const { found, problems } = localClips(dir, items);
    expect([...found.keys()].sort()).toEqual(["v-005", "v-006"]);
    expect(problems).toEqual([
      "S3/Recording 3.m4a: not a voice card's code",
      "S3/v-007.m4a: v-007 is S4's card",
      "S3: no file for v-014",
    ]);
  });

  it.each([
    ["Bangla script", "এক্সিও ২০১৪ সামনের ব্রেক প্যাড আছে?"],
    ["Banglish", "Axio 2014 samner brake pad ache?"],
  ])("saves one item's transcript and leaves every other byte as it was (%s)", (_, said) => {
    const file =
      '{"id": "v-001", "channel": "voice", "reference_transcript": ""}\n' +
      '{"id":"v-201","channel":"voice","reference_transcript":"old \\"text\\""}\n' +
      '{"id": "c-001", "channel": "chat"}\n';
    const once = withTranscript(file, "v-201", `  ${said}  `);
    expect(once.split("\n")[0]).toBe('{"id": "v-001", "channel": "voice", "reference_transcript": ""}');
    expect(once.split("\n")[1]).toBe(
      `{"id":"v-201","channel":"voice","reference_transcript":${JSON.stringify(said)}}`,
    );
    expect(once.endsWith('{"id": "c-001", "channel": "chat"}\n')).toBe(true);
    const twice = withTranscript(once, "v-001", said);
    expect(JSON.parse(twice.split("\n")[0]!).reference_transcript).toBe(said);
    expect(
      twice.split("\n")[0]!.startsWith('{"id": "v-001", "channel": "voice", "reference_transcript": "'),
    ).toBe(true);
    expect(() => withTranscript(file, "v-999", said)).toThrow("no item v-999");
  });
});
