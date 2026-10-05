import { describe, expect, it } from "vitest";
import { banglaNumbers, numberWords, spokenText } from "./format";

// The text sent to text-to-speech (spec 10.8, P7, D109): numbers as Bangla words, codes and labels as written. The
// answers are always Bangla; the digits in them come from the templates (Bangla digits) or the LLM (either).

describe("numbers for speech", () => {
  it.each([
    [0, "শূন্য"],
    [16, "ষোলো"],
    [100, "একশো"],
    [200, "দুইশো"],
    [1_990, "এক হাজার নয়শো নব্বই"],
    [4_200, "চার হাজার দুইশো"],
    [20_500, "বিশ হাজার পাঁচশো"],
    [35_30_556, "পঁয়ত্রিশ লাখ ত্রিশ হাজার পাঁচশো ছাপ্পান্ন"],
    [12_00_00_000, "বারো কোটি"],
  ])("says %i as %s", (value, words) => {
    expect(numberWords(value)).toBe(words);
  });

  it.each([
    {
      shown:
        "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।",
      spoken:
        "এক্সিও দুই হাজার চৌদ্দ এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন তিন সেট, চার হাজার পাঁচশো টাকা; নন-জেনুইন ছয় সেট, এক হাজার আটশো টাকা। দুটোই B-3 তাকে।",
    },
    {
      shown: "স্টকের মোট দাম ৩৫,৩০,৫৫৬ টাকা।",
      spoken: "স্টকের মোট দাম পঁয়ত্রিশ লাখ ত্রিশ হাজার পাঁচশো ছাপ্পান্ন টাকা।",
    },
    {
      shown: "নোয়া ১৯৯৯ মডেলের ৩টা আছে, ১.৫ লিটার।",
      spoken: "নোয়া উনিশশো নিরানব্বই মডেলের তিনটা আছে, দেড় লিটার।",
    },
    {
      shown: "New Dhaka Garage এর বাকি 20,500 টাকা।",
      spoken: "New Dhaka Garage এর বাকি বিশ হাজার পাঁচশো টাকা।",
    },
  ])("says amounts, years and quantities in words: $shown", ({ shown, spoken }) => {
    expect(spokenText(shown)).toBe(spoken);
  });

  it("leaves part numbers, phone numbers, racks and engine codes as written", () => {
    for (const text of [
      "পার্ট নম্বর 04465-10047।",
      "ফোন 01711-000104।",
      "B-3 তাকে",
      "1NZ ইঞ্জিন",
      "5W-30 তেল",
    ]) {
      expect(spokenText(text)).toBe(text);
    }
  });
});

describe("numbers in the LLM's sentences (D118)", () => {
  it.each([
    { written: "Karim Auto এর বাকি আছে 21,900 টাকা।", shown: "Karim Auto এর বাকি আছে ২১,৯০০ টাকা।" },
    { written: "করিম অটোর বাকি 21900 টাকা।", shown: "করিম অটোর বাকি ২১,৯০০ টাকা।" },
    { written: "স্টকের মোট দাম 3530556 taka.", shown: "স্টকের মোট দাম ৩৫,৩০,৫৫৬ taka." },
    { written: "এক্সিও 2014-এর ৩ সেট আছে।", shown: "এক্সিও ২০১৪-এর ৩ সেট আছে।" },
    { written: "1.5 লিটার আছে।", shown: "১.৫ লিটার আছে।" },
  ])("writes amounts, years and quantities in Bangla digits: $written", ({ written, shown }) => {
    expect(banglaNumbers(written)).toBe(shown);
  });

  it("leaves Bangla digits, part numbers, phone numbers, racks and engine codes as written", () => {
    for (const text of [
      "নিউ ঢাকা গ্যারেজের বাকি ২০,৫০০ টাকা।",
      "পার্ট নম্বর 04465-10047।",
      "ফোন নম্বর হলো 01711-000104।",
      "B-3 তাকে",
      "1NZ ইঞ্জিন",
      "5W-30 তেল",
    ]) {
      expect(banglaNumbers(text)).toBe(text);
    }
  });
});
