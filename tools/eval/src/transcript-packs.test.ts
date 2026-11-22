import { describe, expect, it } from "vitest";
import { itemSchema, type Item } from "./items";
import { importTranscripts, packPage, splitParts } from "./transcript-packs";

// The transcript packs shared on Google Drive and the typing that comes back (D244).

const voice = (id: string, transcript = ""): Item =>
  itemSchema.parse({
    id,
    channel: "voice",
    split: "open",
    kind: "other_read",
    task_card: "Ask the due",
    expected: { answer: "see_in_app" },
    speaker: "S3",
    audio: `recordings/<shop_id>/eval/${id}.wav`,
    reference_transcript: transcript,
  });

const lines = (items: Item[]) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";

describe("transcript packs", () => {
  it("cuts the clips into equal runs, in order", () => {
    const rows = Array.from({ length: 126 }, (_, i) => i);
    const parts = splitParts(rows, 3);
    expect(parts.map((part) => part.length)).toEqual([42, 42, 42]);
    expect(parts.flat()).toEqual(rows);
    expect(
      splitParts(
        Array.from({ length: 86 }, (_, i) => i),
        3,
      ).map((part) => part.length),
    ).toEqual([28, 29, 29]);
    expect(splitParts([1, 2], 3)).toEqual([[1], [2]]);
    expect(() => splitParts([1], 0)).toThrow();
  });

  it("makes a page that carries its clips and asks nothing of a server", () => {
    const page = packPage(
      {
        name: "18nov-part-1",
        part: 1,
        of: 3,
        clips: [{ id: "v-203", speaker: "S3", card: "রাখুন </script><b>" }],
      },
      new Map([["v-203", Buffer.from("ID3 fake mp3")]]),
    );
    expect(page).toContain("Transcripts, part 1 of 3");
    expect(page).toContain(`data:audio/mpeg;base64,${Buffer.from("ID3 fake mp3").toString("base64")}`);
    expect(page).not.toContain("fetch(");
    expect(page).not.toMatch(/https?:\/\//);
    // The card's own text cannot close the data's script element.
    expect(page.match(/<\/script>/g)).toHaveLength(2);
    const data = page.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)![1]!;
    expect(JSON.parse(data).clips[0].card).toBe("রাখুন </script><b>");
  });

  it("refuses a page without one of its clips", () => {
    expect(() =>
      packPage({ name: "x", part: 1, of: 1, clips: [{ id: "v-001", speaker: "S3", card: "" }] }, new Map()),
    ).toThrow("no audio for v-001");
  });

  it("writes the returned typing into items.jsonl, skipping a box left empty", () => {
    const items = [voice("v-203"), voice("v-208", "আগের লেখা"), voice("v-210")];
    const back = JSON.stringify({
      pack: "18nov-part-1",
      transcripts: [
        { id: "v-203", text: "  এক্সিও   ২০১৪ সামনের ব্রেক প্যাড C-1 এ রাখো " },
        { id: "v-208", text: "কোন কোন মাল শেষ" },
        { id: "v-210", text: "   " },
      ],
    });
    const result = importTranscripts(lines(items), items, back);
    expect(result.saved).toEqual(["v-203", "v-208"]);
    expect(result.changed).toEqual(["v-208"]);
    expect(result.empty).toEqual(["v-210"]);
    const after = result.next
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Item);
    expect(after.map((item) => item.reference_transcript)).toEqual([
      "এক্সিও ২০১৪ সামনের ব্রেক প্যাড C-1 এ রাখো",
      "কোন কোন মাল শেষ",
      "",
    ]);
  });

  it("stops before any write on an id that is not a voice card", () => {
    const items = [voice("v-203")];
    const back = JSON.stringify({ pack: "x", transcripts: [{ id: "c-001", text: "দাম কত" }] });
    expect(() => importTranscripts(lines(items), items, back)).toThrow(
      "not voice cards of the test set: c-001",
    );
    expect(() => importTranscripts(lines(items), items, "{}")).toThrow();
  });
});
