import { buildDictionary } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { followUpSlot } from "./frame";

// A short follow-up changes one detail of the last part search (spec 9.8, D95); a new request is not one.

const dictionary = buildDictionary();
const now = new Date("2026-09-28T10:00:00Z");

describe("follow-up to the last part search", () => {
  it("reads a position, quality or year said alone, in Bangla or Banglish", () => {
    expect(followUpSlot("pechoner ta?", dictionary, now)).toMatchObject({ slot: "position" });
    expect(followUpSlot("পেছনেরটা?", dictionary, now)).toMatchObject({ slot: "position" });
    expect(followUpSlot("আর জেনুইনটা?", dictionary, now)).toMatchObject({ slot: "quality" });
    expect(followUpSlot("2016 er ta?", dictionary, now)).toEqual({ slot: "year", value: "2016" });
  });

  it("is not a follow-up when a part or a car is named, or when it is long", () => {
    expect(followUpSlot("noah er self ache?", dictionary, now)).toBeNull();
    expect(followUpSlot("pechoner brake pad", dictionary, now)).toBeNull();
    expect(followUpSlot("rahim motors er baki koto?", dictionary, now)).toBeNull();
    expect(followUpSlot("ajke bristi hobe?", dictionary, now)).toBeNull();
  });
});
