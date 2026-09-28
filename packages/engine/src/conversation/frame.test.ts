import { buildDictionary } from "@dokaanbondhu/core";
import { describe, expect, it } from "vitest";
import { answerFrame, asking, correctedSlot, isOpen, newFrame, splitCorrection } from "./frame";
import { canTransition, transition, TransitionRefused } from "./state";

const dictionary = buildDictionary();
const now = new Date("2026-09-28T10:00:00+06:00");
const customers = [
  { hostId: "c1", name: "Rahim Motors", nameBn: null },
  { hostId: "c2", name: "Rahim Auto Garage", nameBn: null },
  { hostId: "c3", name: "Karim Auto", nameBn: null },
];

describe("request frame (spec 9.3)", () => {
  it("fills the asked slot from a chip tap, and only that slot", () => {
    const frame = newFrame("f1", "find_parts", now);
    asking(frame, "year", [
      { id: "opt-1", label: "2007–2013", value: "2007" },
      { id: "opt-2", label: "2014–2021", value: "2014" },
    ]);
    expect(
      answerFrame(frame, { choice: { slot: "year", optionId: "opt-2" }, dictionary, customers, now }),
    ).toBe("year");
    expect(frame.slots.year).toMatchObject({ value: "2014", status: "understood", source: "user" });
    expect(frame.asking).toBeUndefined();
  });

  // Each answer is typed both ways, Bangla script and Banglish (D96).
  it.each([
    { style: "Bangla", year: "২০১৬ সালের", other: "করিম অটোর বাকি কত" },
    { style: "Banglish", year: "2016 saler", other: "karim auto r baki koto" },
  ])(
    "parses a spoken year for the year question, and leaves a new request to the LLM ($style)",
    ({ year, other }) => {
      const frame = newFrame("f1", "find_parts", now);
      asking(frame, "year");
      expect(answerFrame(frame, { text: year, dictionary, customers, now })).toBe("year");
      expect(frame.slots.year?.value).toBe("2016");
      asking(frame, "year");
      expect(answerFrame(frame, { text: other, dictionary, customers, now })).toBeNull();
    },
  );

  it.each([
    { style: "Bangla", name: "রহিম মোটরস" },
    { style: "Banglish", name: "rahim motors" },
  ])("takes a customer only among the names offered ($style)", ({ name }) => {
    const frame = newFrame("f1", "resolve_customer", now);
    asking(frame, "customer", [
      { id: "opt-1", label: "Rahim Motors", value: "c1" },
      { id: "opt-2", label: "Rahim Auto Garage", value: "c2" },
    ]);
    expect(answerFrame(frame, { text: name, dictionary, customers, now })).toBe("customer");
    // A name typed as the chip's label fills the chip's value, the host ID, as a tap does; the turn reads either.
    const chosen = frame.slots.customer;
    expect(chosen?.hostId ?? chosen?.value).toBe("c1");
  });

  it.each([
    { style: "Bangla", year: "না, ২০১২", position: "না পেছনের", bare: "২০১২" },
    { style: "Banglish", year: "na, 2012", position: "na pechoner", bare: "2012" },
  ])("reads 'no, X' as a correction of the slot X belongs to ($style)", ({ year, position, bare }) => {
    expect(splitCorrection(year)).toEqual({ correction: true, rest: "2012" });
    expect(correctedSlot(year, dictionary, now)).toEqual({ slot: "year", value: "2012" });
    expect(correctedSlot(position, dictionary, now)).toMatchObject({ slot: "position" });
    expect(correctedSlot(bare, dictionary, now)).toBeNull();
  });

  it("counts attempts, and expires 120 s after the last answer", () => {
    const frame = newFrame("f1", "find_parts", now);
    expect(asking(frame, "year")).toEqual({ attempt: 1, withChips: false });
    asking(frame, "year");
    expect(asking(frame, "year")).toEqual({ attempt: 3, withChips: true });
    expect(isOpen(frame, new Date(now.getTime() + 119_000))).toBe(true);
    expect(isOpen(frame, new Date(now.getTime() + 121_000))).toBe(false);
  });
});

describe("state machine (spec 9.2)", () => {
  it("allows the listed transitions and refuses the rest", () => {
    expect(canTransition("IDLE", "UNDERSTANDING")).toBe(true);
    expect(canTransition("UNDERSTANDING", "CLARIFYING")).toBe(true);
    expect(canTransition("CONFIRMING", "EXECUTING")).toBe(true);
    expect(canTransition("IDLE", "EXECUTING")).toBe(false);
    expect(() => transition("LISTENING", "CONFIRMING")).toThrow(TransitionRefused);
  });
});
