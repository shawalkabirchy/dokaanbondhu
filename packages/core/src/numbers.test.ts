import { describe, expect, it } from "vitest";
import { formatTaka, money, quantity, year } from "./format";
import { expandYear, matchPartNumber, normalizePartNumber, parseEngineCode, parseYear } from "./numbers";
import { checkQuantity, parseQuantity } from "./quantity";
import { normalize } from "./text";

const now = new Date("2026-09-28T12:00:00+06:00");
const tokens = (text: string) => normalize(text).tokens;

describe("years (spec 10.5)", () => {
  it("reads four digits from 1980 to next year", () => {
    expect(parseYear(tokens("এক্সিও ২০১৪-এর প্যাড"), { now })).toBe(2014);
    expect(parseYear(tokens("axio 2028 pad"), { now })).toBeNull();
    expect(parseYear(tokens("1979 model"), { now })).toBeNull();
  });

  it("reads two digits and number words next to model, sal or their Bangla words", () => {
    expect(parseYear(tokens("14 model er axio"), { now })).toBe(2014);
    expect(parseYear(tokens("চৌদ্দ সালের এক্সিও"), { now })).toBe(2014);
    expect(parseYear(tokens("৯৮ মডেল"), { now })).toBe(1998);
    expect(parseYear(tokens("axio 14 er pad"), { now })).toBeNull();
    expect(parseYear(tokens("14"), { now, bare: true })).toBe(2014);
  });

  // Speech-to-text writes years in words (D101); "দুই" alone must never become 2002.
  it.each([
    { style: "Bangla", said: "দুই হাজার চৌদ্দ", year: 2014 },
    { style: "Bangla", said: "এক্সিও দুই হাজার ষোল সালের", year: 2016 },
    { style: "Bangla", said: "উনিশ শো নিরানব্বই", year: 1999 },
    { style: "Banglish", said: "dui hajar choddo", year: 2014 },
    { style: "Banglish", said: "axio dui hajar sholo saler", year: 2016 },
    { style: "Banglish", said: "unish sho nobbui", year: 1990 },
    { style: "Bangla", said: "এক জিও দুই হাজার চৌদ্দ এর সামনে ব্রেকপ্যান আছে", year: 2014 },
    { style: "Banglish", said: "ek jio dui hajar choddo er samne brake pad ache", year: 2014 },
  ])("reads a year said in words: $said ($style)", ({ said, year }) => {
    expect(parseYear(tokens(said), { now })).toBe(year);
    expect(parseYear(tokens(said), { now, bare: true })).toBe(year);
  });

  it("expands two digits to 2000 + n up to next year, else 1900 + n", () => {
    expect(expandYear(27, now)).toBe(2027);
    expect(expandYear(28, now)).toBe(1928);
  });
});

describe("engine codes and part numbers (spec 10.5)", () => {
  it("reads written and spelled engine codes", () => {
    expect(parseEngineCode(tokens("1nz engine"))).toBe("1NZ");
    expect(parseEngineCode(tokens("one en zed er engine"))).toBe("1NZ");
    expect(parseEngineCode(tokens("ওয়ান এন জেড"))).toBe("1NZ");
    expect(parseEngineCode(tokens("2zr-fxe"))).toBe("2ZR-FXE");
    expect(parseEngineCode(tokens("axio pad"))).toBeNull();
  });

  it("uses an exact part number and only offers a near one", () => {
    const known = ["04465-10010", "04465-10047", "AN-101WK"];
    expect(normalizePartNumber("04465 10010")).toBe("0446510010");
    expect(matchPartNumber("০৪৪৬৫-১০০১০", known)).toEqual({ exact: "04465-10010", offered: [] });
    expect(matchPartNumber("an101wk", known)).toEqual({ exact: "AN-101WK", offered: [] });
    expect(matchPartNumber("04465-10019", known)).toEqual({ exact: null, offered: ["04465-10010"] });
  });
});

describe("quantities (spec 10.6)", () => {
  it("reads digits, number words, classifiers, fractions and units", () => {
    expect(parseQuantity(tokens("দুইটা দেন"))).toEqual({ value: 2, unit: "piece" });
    expect(parseQuantity(tokens("২ সেট প্যাড"))).toEqual({ value: 2, unit: "set" });
    expect(parseQuantity(tokens("ekta pad"))).toEqual({ value: 1, unit: "piece" });
    expect(parseQuantity(tokens("দেড় লিটার মবিল"))).toEqual({ value: 1.5, unit: "liter" });
    expect(parseQuantity(tokens("সাড়ে তিন লিটার"))).toEqual({ value: 3.5, unit: "liter" });
    expect(parseQuantity(tokens("পৌনে দুই লিটার"))).toEqual({ value: 1.75, unit: "liter" });
    expect(parseQuantity(tokens("one hali plug"))).toEqual({ value: 1, unit: "hali" });
    expect(parseQuantity(tokens("tin set pad"))).toEqual({ value: 3, unit: "set" });
    expect(parseQuantity(tokens("2 tin mobil"))).toEqual({ value: 2, unit: "tin" });
  });

  it("checks against how the part is sold", () => {
    expect(checkQuantity({ value: 2, unit: "set" }, { unit: "set" })).toEqual({ ok: true, quantity: 2 });
    expect(checkQuantity({ value: 1, unit: "hali" }, { unit: "piece" })).toEqual({ ok: true, quantity: 4 });
    expect(checkQuantity({ value: 2, unit: "piece" }, { unit: "set" })).toEqual({
      ok: false,
      reason: "ask_unit",
    });
    expect(checkQuantity({ value: 1, unit: "pair" }, { unit: "set" })).toEqual({
      ok: false,
      reason: "ask_unit",
    });
    expect(checkQuantity({ value: 1, unit: "tin" }, { unit: "liter", packSize: 4 })).toEqual({
      ok: true,
      quantity: 4,
    });
    expect(checkQuantity({ value: 1, unit: "tin" }, { unit: "liter" })).toEqual({
      ok: false,
      reason: "ask_pack",
    });
    expect(checkQuantity({ value: 1.5, unit: null }, { unit: "set" })).toEqual({
      ok: false,
      reason: "fraction_not_allowed",
    });
    expect(checkQuantity({ value: 1.5, unit: "liter" }, { unit: "liter" })).toEqual({
      ok: true,
      quantity: 1.5,
    });
    expect(checkQuantity({ value: 2000, unit: "piece" }, { unit: "piece" })).toEqual({
      ok: false,
      reason: "unclear",
    });
  });
});

describe("numbers in answers (spec 10.8)", () => {
  it("writes money in whole taka with Bangla digits and Bangladeshi grouping (D92)", () => {
    expect(money(420000n)).toBe("৪,২০০ টাকা");
    expect(formatTaka(12345650n, { bangla: false })).toBe("1,23,457"); // half a taka rounds up
    expect(formatTaka(12345649n, { bangla: false })).toBe("1,23,456");
    expect(formatTaka(-150050n, { bangla: false })).toBe("-1,501"); // away from zero
    expect(formatTaka(49n, { bangla: false })).toBe("0");
  });

  it("writes years and quantities", () => {
    expect(year(2014)).toBe("২০১৪");
    expect(quantity(2, "set")).toBe("২ সেট");
    expect(quantity(3, "piece")).toBe("৩টা");
    expect(quantity(1.5, "liter")).toBe("১.৫ লিটার");
  });
});
