import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cardsMarkdown, expectedText, IN_SHOP, sheetCards, SPEAKERS, speakerSheet } from "./cards";
import { loadItems } from "./items";

// The test set's views (D184): every voice card on exactly one speaker's sheet, the sheets balanced, and the card
// list showing every item.

const items = loadItems(fileURLToPath(new URL("../items.jsonl", import.meta.url)));
const voice = items.filter((item) => item.channel === "voice");

describe("speaker sheets", () => {
  it("puts every voice card on exactly one sheet, 40 to each speaker, the same order every time", () => {
    const onSheets = SPEAKERS.flatMap((speaker) => sheetCards(items, speaker).map((item) => item.id));
    expect(onSheets.sort()).toEqual(voice.map((item) => item.id).sort());
    for (const speaker of SPEAKERS) {
      const cards = sheetCards(items, speaker);
      expect(cards, speaker).toHaveLength(40);
      expect(sheetCards(items, speaker)).toEqual(cards);
      // Each speaker has both halves and every kind in the same share.
      expect(cards.filter((item) => item.split === "open")).toHaveLength(20);
      const kinds = Object.fromEntries(
        ["part_lookup", "other_read", "write", "must_not_act"].map((kind) => [
          kind,
          cards.filter((item) => item.kind === kind).length,
        ]),
      );
      expect(kinds, speaker).toEqual({ part_lookup: 14, other_read: 8, write: 12, must_not_act: 6 });
    }
  });

  it("records at least a third in the shop (architecture 11.2)", () => {
    const inShop = voice.filter((item) => IN_SHOP.includes(item.speaker ?? "")).length;
    expect(inShop / voice.length).toBeGreaterThanOrEqual(1 / 3);
  });

  it("prints each card in Bangla with its code, and the rules", () => {
    const sheet = speakerSheet(items, "S3");
    for (const item of sheetCards(items, "S3")) {
      expect(sheet).toContain(`<td class="id">${item.id}</td>`);
      expect(item.task_card_bn, item.id).toBeTruthy();
    }
    expect(sheet).toContain("নিজের ভাষায়");
    expect(sheet).not.toContain("সম্মতিপত্র");
  });
});

describe("card list", () => {
  it("lists every item, with the actions built since the draft", () => {
    const list = cardsMarkdown(items, "22 Oct 2026");
    for (const item of items) expect(list).toContain(`| ${item.id} |`);
    const text = items.map(expectedText).join("\n");
    expect(text).toMatch(/add_customer → .+ \(garage, 01\d{3}-\d{6}\)/);
    expect(text).toMatch(/add_supplier → /);
    expect(text).toMatch(/sale → `[^`]+` at \d+ each/);
  });

  it("keeps the mix of the architecture's test set in every channel and half", () => {
    for (const channel of ["chat", "voice"])
      for (const split of ["open", "held_out"]) {
        const group = items.filter((item) => item.channel === channel && item.split === split);
        const count = (kind: string) => group.filter((item) => item.kind === kind).length;
        expect([count("part_lookup"), count("other_read"), count("write"), count("must_not_act")]).toEqual([
          35, 20, 30, 15,
        ]);
        expect(group.filter((item) => item.needs_question).length).toBeGreaterThanOrEqual(30);
        if (channel === "chat")
          expect(group.filter((item) => item.script_style === "bangla")).toHaveLength(50);
      }
  });
});
