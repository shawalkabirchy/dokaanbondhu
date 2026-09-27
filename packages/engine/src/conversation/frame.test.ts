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

  it("parses a spoken year for the year question, and leaves a new request to the LLM", () => {
    const frame = newFrame("f1", "find_parts", now);
    asking(frame, "year");
    expect(answerFrame(frame, { text: "২০১৬ সালের", dictionary, customers, now })).toBe("year");
    expect(frame.slots.year?.value).toBe("2016");
    asking(frame, "year");
    expect(answerFrame(frame, { text: "করিম অটোর বাকি কত", dictionary, customers, now })).toBeNull();
  });

  it("takes a customer only among the names offered", () => {
    const frame = newFrame("f1", "resolve_customer", now);
    asking(frame, "customer", [
      { id: "opt-1", label: "Rahim Motors", value: "c1" },
      { id: "opt-2", label: "Rahim Auto Garage", value: "c2" },
    ]);
    expect(answerFrame(frame, { text: "রহিম মোটরস", dictionary, customers, now })).toBe("customer");
    expect(frame.slots.customer).toMatchObject({ hostId: "c1" });
  });

  it("reads 'no, X' as a correction of the slot X belongs to", () => {
    expect(splitCorrection("না, ২০১২")).toEqual({ correction: true, rest: "2012" });
    expect(correctedSlot("না, ২০১২", dictionary, now)).toEqual({ slot: "year", value: "2012" });
    expect(correctedSlot("না পেছনের", dictionary, now)).toMatchObject({ slot: "position" });
    expect(correctedSlot("২০১২", dictionary, now)).toBeNull();
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
