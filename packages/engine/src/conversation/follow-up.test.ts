import { buildDictionary } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { followUpSlot } from "./frame";

// A short follow-up changes one detail of the last part search (spec 9.8, D95); a new request is not one. Each case
// is said both ways, Bangla script and Banglish (D96).

const dictionary = buildDictionary();
const now = new Date("2026-09-28T10:00:00Z");

describe("follow-up to the last part search", () => {
  it.each([
    { bangla: "পেছনেরটা?", banglish: "pechoner ta?", slot: "position" },
    { bangla: "আর জেনুইনটা?", banglish: "ar genuine ta?", slot: "quality" },
    { bangla: "২০১৬-এর টা?", banglish: "2016 er ta?", slot: "year" },
  ])("reads a $slot said alone, in Bangla and in Banglish", ({ bangla, banglish, slot }) => {
    expect(followUpSlot(bangla, dictionary, now)).toMatchObject({ slot });
    expect(followUpSlot(banglish, dictionary, now)).toMatchObject({ slot });
  });

  it("reads the year as digits, whichever script they are typed in", () => {
    expect(followUpSlot("২০১৬-এর টা?", dictionary, now)).toEqual({ slot: "year", value: "2016" });
    expect(followUpSlot("2016 er ta?", dictionary, now)).toEqual({ slot: "year", value: "2016" });
  });

  it.each([
    { bangla: "নোয়ার সেলফ আছে?", banglish: "noah er self ache?" },
    { bangla: "পেছনের ব্রেক প্যাড", banglish: "pechoner brake pad" },
    { bangla: "রহিম মোটরসের বাকি কত?", banglish: "rahim motors er baki koto?" },
    { bangla: "আজকে বৃষ্টি হবে?", banglish: "ajke bristi hobe?" },
  ])(
    "is not a follow-up when a part or a car is named, or when it is long: $banglish",
    ({ bangla, banglish }) => {
      expect(followUpSlot(bangla, dictionary, now)).toBeNull();
      expect(followUpSlot(banglish, dictionary, now)).toBeNull();
    },
  );
});
