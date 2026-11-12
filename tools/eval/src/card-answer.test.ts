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

const v116 = itemSchema.parse({
  id: "v-116",
  channel: "voice",
  split: "open",
  kind: "write",
  as: "staff",
  task_card: "Add a new paikari (garage) customer Al-Amin Auto Garage, phone 01755-201101",
  task_card_bn: "নতুন কাস্টমার যোগ করুন: আল-আমিন অটো গ্যারেজ, পাইকারি, ফোন ০১৭৫৫-২০১১০১",
  expected: {
    action: "add_customer",
    slots: {
      name: "Al-Amin Auto Garage",
      name_bn: "আল-আমিন অটো গ্যারেজ",
      party_type: "garage",
      phone: "01755-201101",
    },
  },
  script: { confirm: "yes", new_check: "নতুন হিসেবে যোগ করুন" },
});
const v134 = itemSchema.parse({
  id: "v-134",
  channel: "voice",
  split: "open",
  kind: "write",
  as: "owner",
  task_card:
    "As the owner: sell 4 × right headlight for a 2017 Axio to Madina Auto Works at 5,850 taka each for cash",
  task_card_bn:
    "মালিক হিসেবে: মদিনা অটো ওয়ার্কসকে চারটা এক্সিও ২০১৭-এর ডান দিকের হেডলাইট প্রতিটা ৫,৮৫০ টাকা দরে নগদে বিক্রি করুন",
  expected: {
    action: "sale",
    slots: { customer: "Madina Auto Works", quantity: 4, payment: "cash", unit_price: 5850 },
    part: { part_type: "Headlight", vehicle: "Toyota Axio", year: 2017, position: "right" },
    part_key: "LOC-HEA-1037",
  },
  script: { confirm: "yes" },
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

  it("says the phone and the price the card names, a number written with commas whole (D239)", () => {
    expect(cardAnswer(v116, { slot: "new_phone" })).toBe("01755-201101");
    expect(cardAnswer(v134, { slot: "unit_price" })).toBe("5850");
    expect(cardAnswer(v134, { slot: "quantity" })).toBe("4");
  });

  it("says the car in words when no button has it (D239)", () => {
    expect(cardAnswer(v119, { slot: "vehicle", options: ["এক্সিও", "প্রিমিও", "ফিল্ডার"] })).toBe(
      "Toyota RAV4",
    );
  });
});
