import { describe, expect, it } from "vitest";
import { buildDictionary } from "./glossary";
import { namesInText, racksInText } from "./names";

// The shop's own names said inside a request (D95, D108), in Bangla and Banglish (D96).

const dictionary = buildDictionary();
const names = [
  { kind: "customer", name: "New Dhaka Garage" },
  { kind: "customer", name: "Rahim Motors" },
  { kind: "customer", name: "Friends Motor Workshop" },
  { kind: "supplier", name: "Eastern Lubricants" },
];

describe("names in a request", () => {
  it.each([
    { style: "Bangla", text: "নিউ ঢাকা গ্যারেজের ফোন নম্বর কত?", name: "New Dhaka Garage" },
    { style: "Banglish", text: "New Dhaka Garage er phone number koto?", name: "New Dhaka Garage" },
    { style: "Bangla", text: "রহিম মোটরসের বাকি কত?", name: "Rahim Motors" },
    { style: "Banglish", text: "rahim motors er baki koto", name: "Rahim Motors" },
    { style: "Bangla", text: "ইস্টার্ন লুব্রিকেন্টসের ফোন নম্বর দিন", name: "Eastern Lubricants" },
    { style: "Banglish", text: "eastern lubricants er phone number", name: "Eastern Lubricants" },
  ])("finds a customer or supplier said in either script, with an ending ($style)", ({ text, name }) => {
    const found = namesInText(text, names, dictionary);
    expect(found.map((named) => named.name)).toEqual([name]);
  });

  it.each([
    { style: "Bangla", text: "এক্সিও ২০১৪ সামনের ব্রেক প্যাড আছে?" },
    { style: "Banglish", text: "motor er brake pad ache?" },
    { style: "Bangla", text: "রহিম সাহেব কী নিল?" },
  ])("finds no name in a request without one, or with only a part of one ($style)", ({ text }) => {
    expect(namesInText(text, names, dictionary)).toEqual([]);
  });
});

describe("racks in a request", () => {
  const racks = ["C-2", "B-3", "A1", "Top shelf"];

  it.each([
    { style: "Bangla", text: "সি-২ তাকে কী কী আছে?", rack: "C-2" },
    { style: "Bangla", text: "সি ২ র‍্যাকে কী আছে?", rack: "C-2" },
    { style: "Banglish", text: "C-2 rack e ki ki ache?", rack: "C-2" },
    { style: "Banglish", text: "c2 rack e ki ache", rack: "C-2" },
    { style: "Banglish", text: "b 3 te ki ki ache", rack: "B-3" },
  ])("finds a rack written or spelled ($style: $text)", ({ text, rack }) => {
    expect(racksInText(text, racks).map((named) => named.name)).toEqual([rack]);
  });

  it("finds no rack in a request without one", () => {
    expect(racksInText("এক্সিও ২০১৪ সামনের ব্রেক প্যাড আছে?", racks)).toEqual([]);
    expect(racksInText("axio 2014 front brake pad ache?", racks)).toEqual([]);
  });

  // D118: from the voice test of 5 Oct and the Banglish typed check.
  it.each([
    { style: "Bangla", text: "সি দুই তাকে কী কী আছে?", heard: "সি দুই" },
    { style: "Banglish", text: "C dui rack e ki ki ache?", heard: "c dui" },
    { style: "Bangla", text: "সিধুই তাকে কি কি আছে", heard: "সিধুই" },
    { style: "Banglish", text: "sidui take ki ki ache", heard: "sidui" },
  ])("finds a rack said with digit words or written as one word ($style: $text)", ({ text, heard }) => {
    expect(racksInText(text, racks)).toEqual([{ kind: "rack", name: "C-2", heard, score: 1 }]);
  });

  it.each([
    { style: "Bangla", text: "সিধুই কি আছে?" },
    { style: "Banglish", text: "sidui ki ache?" },
    { style: "Bangla", text: "তাকে কী কী আছে?" },
    { style: "Banglish", text: "take ki ki ache?" },
  ])(
    "takes one word as a rack only next to a rack word, and never a one-letter sound ($style: $text)",
    ({ text }) => {
      expect(racksInText(text, [...racks, "C-1"])).toEqual([]);
    },
  );
});
