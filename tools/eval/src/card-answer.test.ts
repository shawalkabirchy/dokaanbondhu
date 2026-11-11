import { describe, expect, it } from "vitest";
import { cardAnswer } from "./card-answer";
import { itemSchema } from "./items";

// The runner answers a fair question from the card, only with words on it (D237): cards from the test set.

const v205 = itemSchema.parse({
  id: "v-205",
  channel: "voice",
  split: "open",
  kind: "write",
  as: "owner",
  task_card: "As the owner: put the genuine air filter of the Premio 2010 on rack H-1",
  task_card_bn: "মালিক হিসেবে: প্রিমিও ২০১০-এর জেনুইন এয়ার ফিল্টার এইচ-১ র‍্যাকে রাখুন",
  expected: { action: "rack_update", slots: { rack: "H-1" }, part_key: "17801-10047" },
  script: { confirm: "yes" },
});
const v119 = itemSchema.parse({
  id: "v-119",
  channel: "voice",
  split: "open",
  kind: "write",
  task_card: "Record 6 × radiator cap for a 2009 RAV4 received from Bangshal Motor Supply at 420 taka each",
  task_card_bn:
    "লিখে রাখুন বংশাল মোটর সাপ্লাই থেকে ছয়টা র‍্যাভ ফোর ২০০৯-এর রেডিয়েটর ক্যাপ এসেছে, প্রতিটা ৪২০ টাকা",
  expected: {
    action: "stock_in",
    slots: { supplier: "Bangshal Motor Supply", quantity: 6, unit_cost: 420 },
    part: { part_type: "Radiator Cap", vehicle: "Toyota RAV4", year: 2009 },
    part_key: "16401-10010",
  },
  script: { payment: "বাকিতে", confirm: "yes" },
});

describe("a question answered from the card (D237)", () => {
  it("picks the one button whose words are on the card", () => {
    expect(
      cardAnswer(v205, { slot: "part_pick", options: ["এয়ার ফিল্টার, Toyota", "অয়েল ফিল্টার, Toyota"] }),
    ).toBe("এয়ার ফিল্টার, Toyota");
  });

  it("picks none when two buttons or none fit", () => {
    expect(
      cardAnswer(v205, { slot: "part_pick", options: ["ফিল্টার, Toyota", "ফিল্টার, Nissan"] }),
    ).toBeNull();
    expect(cardAnswer(v205, { slot: "part_pick", options: ["অয়েল ফিল্টার", "ফুয়েল ফিল্টার"] })).toBeNull();
  });

  it("says the car, year and part the card names", () => {
    expect(cardAnswer(v119, { slot: "vehicle" })).toBe("Toyota RAV4");
    expect(cardAnswer(v119, { slot: "year" })).toBe("2009");
    expect(cardAnswer(v119, { slot: "part_type" })).toBe("Radiator Cap");
  });

  it("says nothing the card does not name", () => {
    expect(cardAnswer(v119, { slot: "position" })).toBeNull();
    expect(cardAnswer(v205, { slot: "vehicle" })).toBeNull();
    expect(cardAnswer(v205, { slot: null })).toBeNull();
  });
});
