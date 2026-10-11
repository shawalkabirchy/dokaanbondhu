import { ASK_AGAIN } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { keptConversations, scoreClip, summarize, type ClipStorage } from "./clips";

// The replay of the test shop's kept clips (D149): each conversation's clips in the order they were said, scored
// against what the owner meant.

const shop = "7d03dee4-47a3-41d6-8f81-a5930f4ae39a";

function storageOf(
  tree: Record<string, { name: string; createdAt?: string; folder?: boolean }[]>,
): ClipStorage {
  return {
    list: async (path) =>
      (tree[path] ?? []).map((entry) => ({
        name: entry.name,
        createdAt: entry.createdAt ?? null,
        folder: entry.folder ?? false,
      })),
    download: async () => new Uint8Array(0),
  };
}

describe("kept clips", () => {
  it("lists each conversation's clips in the order they were said, from the given date on", async () => {
    const storage = storageOf({
      [`${shop}/live`]: [
        { name: "2026-10-09", folder: true },
        { name: "2026-10-11", folder: true },
      ],
      [`${shop}/live/2026-10-11`]: [
        { name: "conv-b", folder: true },
        { name: "conv-a", folder: true },
      ],
      [`${shop}/live/2026-10-11/conv-a`]: [
        { name: "t2.wav", createdAt: "2026-10-11T10:00:05Z" },
        { name: "t1.wav", createdAt: "2026-10-11T10:00:01Z" },
      ],
      [`${shop}/live/2026-10-11/conv-b`]: [{ name: "t3.wav", createdAt: "2026-10-11T11:00:00Z" }],
    });
    expect(await keptConversations(storage, shop, "2026-10-10")).toEqual([
      {
        conversation: "conv-a",
        clips: [`${shop}/live/2026-10-11/conv-a/t1.wav`, `${shop}/live/2026-10-11/conv-a/t2.wav`],
      },
      { conversation: "conv-b", clips: [`${shop}/live/2026-10-11/conv-b/t3.wav`] },
    ]);
  });

  it.each([
    {
      style: "Bangla",
      meant: "রহিম মোটরসকে এক্সিওর সামনের ব্রেক প্যাড বাকিতে দাও",
      reply: "Rahim Motors, এক্সিওর সামনের ব্রেক প্যাড — কোন বছরের এক্সিও?",
    },
    {
      style: "Banglish",
      meant: "Rahim Motors ke axior samner brake pad bakite dao",
      reply: "Rahim Motors, এক্সিওর সামনের ব্রেক প্যাড — কোন বছরের এক্সিও?",
    },
  ])(
    "passes a clip whose answer holds every expected word, never one asked again ($style)",
    ({ meant, reply }) => {
      const label = { clip: "c1", meant, expect: ["Rahim Motors", "এক্সিও"] };
      expect(scoreClip("c1", { transcript: meant, reply }, label)).toMatchObject({
        passed: true,
        missing: [],
      });
      expect(scoreClip("c1", { reply: "কোন গাড়ির?" }, label)).toMatchObject({
        passed: false,
        missing: ["Rahim Motors", "এক্সিও"],
      });
      const again = scoreClip("c1", { reply: ASK_AGAIN }, { ...label, expect: [] });
      expect(again).toMatchObject({ askedAgain: true, passed: false });
      expect(summarize([again, scoreClip("c2", { reply }, undefined)])).toEqual({
        clips: 2,
        askedAgain: 1,
        labelled: 1,
        passed: 0,
      });
    },
  );
});
