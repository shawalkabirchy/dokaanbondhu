import { describe, expect, it } from "vitest";
import { buildDictionary, GLOSSARY } from "./glossary";
import { aliasEntries, checkedSpellings, learnableWords } from "./learning";

// Which words a shop may learn (D102), in Bangla and Banglish (D96).

const dictionary = buildDictionary();

describe("learnable words", () => {
  it.each([
    { style: "Bangla", heard: "নৌকা", words: "নৌকা" },
    { style: "Banglish", heard: "nouka", words: "nouka" },
  ])("keeps a new way a name was heard ($style)", ({ heard, words }) => {
    expect(learnableWords(heard, dictionary)).toBe(words);
  });

  it.each([
    { why: "words the glossary already has", heard: "এক্সিও" },
    { why: "number words only", heard: "দুই হাজার" },
    { why: "number words only (Banglish)", heard: "dui hajar" },
    { why: "a key too short to tell apart", heard: "নো" },
    { why: "more than four words", heard: "এক দুই তিন চার পাঁচ নৌকা" },
    { why: "nothing", heard: "  " },
  ])("never keeps $why", ({ heard }) => {
    expect(learnableWords(heard, dictionary)).toBeNull();
  });

  it("turns the shop's alias rows into glossary entries, Bangla and Latin apart", () => {
    const entries = aliasEntries([
      { aliasText: "নৌকা", targetConcept: "vehicle_model", targetValue: "Toyota Noah" },
      { aliasText: "Nouka", targetConcept: "vehicle_model", targetValue: "Toyota Noah" },
    ]);
    expect(entries).toEqual([
      { target_concept: "vehicle_model", target_value: "Toyota Noah", bn: ["নৌকা"], latin: [] },
      { target_concept: "vehicle_model", target_value: "Toyota Noah", bn: [], latin: ["nouka"] },
    ]);
    const learned = buildDictionary([...GLOSSARY, ...entries]);
    expect(learnableWords("নৌকা", learned)).toBeNull(); // learned once, never again
  });
});

describe("the listening check's spellings (D102 A)", () => {
  it("keeps how speech-to-text split a name, without the carrier word", () => {
    const result = checkedSpellings("প্রোবক্স", ["প্রো বক্স আছে", "প্রোবক্স আছে"], dictionary);
    expect(result.heard).toEqual(["প্রো বক্স", "প্রোবক্স"]);
    expect(result.keep).toEqual(["প্রো বক্স"]); // the second is the glossary's own word
  });

  it("drops a wild guess that does not sound like the name", () => {
    expect(checkedSpellings("নোয়া", ["রেক্ষ আছে", "মাছ আছে"], dictionary).keep).toEqual([]);
  });

  // D105, from the first live check: only spellings the matcher misses are worth the owner's time.
  it("suggests only what the matcher would miss, and drops the carrier word however it was written", () => {
    const axio = { concept: "vehicle_model" as const, value: "Toyota Axio" };
    expect(checkedSpellings("এক্সিও", ["এক্সেও আছে"], dictionary, axio).keep).toEqual([]); // understood anyway
    // "বক্স" alone sounds like Voxy's "ভক্সি", so the split Probox is ambiguous: worth suggesting.
    const probox = { concept: "vehicle_model" as const, value: "Toyota Probox" };
    expect(checkedSpellings("প্রোবক্স", ["প্রো বক্স আছে"], dictionary, probox).keep).toEqual(["প্রো বক্স"]);
    const alternator = { concept: "part_type" as const, value: "Alternator" };
    expect(
      checkedSpellings("ডায়নামো", ["ডায়ালাম আছে", "ডায়ালমও আছি"], dictionary, alternator).keep,
    ).toEqual(["ডায়ালাম", "ডায়ালমও"]);
    const pads = checkedSpellings("ব্রেক প্যাড", ["ব্রেক প্যাড আছি", "ব্রেক প্যাড আছেই"], dictionary, {
      concept: "part_type",
      value: "Brake Pad",
    });
    expect(pads).toEqual({ heard: ["ব্রেক প্যাড"], keep: [] });
  });

  it.each([
    { style: "Bangla", hypothesis: "ডায়ালাম আছে" },
    { style: "Banglish", hypothesis: "dayalam ache" },
  ])("drops the carrier word in both scripts ($style)", ({ hypothesis }) => {
    const { heard } = checkedSpellings("ডায়নামো", [hypothesis], dictionary);
    expect(heard[0]?.split(" ")).toHaveLength(1);
  });
});
