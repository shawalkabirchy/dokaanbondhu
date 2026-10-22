import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cardsMarkdown, expectedText, IN_SHOP, isAdded, sheetCards, SPEAKERS, speakerSheet } from "./cards";
import { loadItems } from "./items";

// The test set's views (D184): every voice card on exactly one speaker's sheet, the sheets balanced, and the card
// list showing every item.

const all = loadItems(fileURLToPath(new URL("../items.jsonl", import.meta.url)));
/** Step 10's extras (D196, D201): numbered after the 400, so the 400 keep the architecture's mix. */
const extra = isAdded;
const items = all.filter((item) => !extra(item));
const extras = all.filter(extra);
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

describe("step 10's extras (D196, D201)", () => {
  it("are 12 per channel after the 400: reminders and rack changes, half in each split", () => {
    expect(all).toHaveLength(424);
    for (const channel of ["chat", "voice"]) {
      const group = extras.filter((item) => item.channel === channel);
      expect(group.map((item) => item.id)).toEqual(
        Array.from({ length: 12 }, (_, index) => `${channel[0]}-${String(201 + index).padStart(3, "0")}`),
      );
      for (const split of ["open", "held_out"]) {
        const half = group.filter((item) => item.split === split);
        expect(half.filter((item) => item.kind === "other_read")).toHaveLength(3);
        expect(half.filter((item) => item.kind === "write")).toHaveLength(3);
        if (channel === "chat") expect(half.filter((item) => item.script_style === "bangla")).toHaveLength(3);
      }
    }
    for (const item of extras.filter((each) => each.kind === "write"))
      expect(item.expected, item.id).toMatchObject({ action: "rack_update" });
    for (const item of extras.filter((each) => each.kind === "other_read"))
      expect(["low_stock", "old_dues"], item.id).toContain((item.expected as { read: string }).read);
  });

  it("put each new voice card at the end of its speaker's sheet, two or three to each, the old order kept", () => {
    for (const speaker of SPEAKERS) {
      const cards = sheetCards(all, speaker);
      const added = cards.filter(extra);
      expect(added.length, speaker).toBeGreaterThanOrEqual(2);
      expect(added.length, speaker).toBeLessThanOrEqual(3);
      // The first 40 are the sheet as printed before, in the same order; the new ones follow under their own line.
      expect(cards.slice(0, 40)).toEqual(sheetCards(items, speaker));
      expect(cards.slice(40)).toEqual(added);
      const sheet = speakerSheet(all, speaker);
      expect(sheet.indexOf("নতুন কার্ড")).toBeLessThan(sheet.indexOf(`<td class="id">${added[0]!.id}</td>`));
      expect(sheet.indexOf("নতুন কার্ড")).toBeGreaterThan(
        sheet.indexOf(`<td class="id">${cards[39]!.id}</td>`),
      );
    }
  });
});

describe("card list", () => {
  it("lists every item, with the actions built since the draft", () => {
    const list = cardsMarkdown(all, "22 Oct 2026");
    for (const item of all) expect(list).toContain(`| ${item.id} |`);
    const text = all.map(expectedText).join("\n");
    expect(text).toMatch(/add_customer → .+ \(garage, 01\d{3}-\d{6}\)/);
    expect(text).toMatch(/add_supplier → /);
    expect(text).toMatch(/sale → `[^`]+` at \d+ each/);
    expect(text).toMatch(/rack_update → `AN-136WK` on D-2/);
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
