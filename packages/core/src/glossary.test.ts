import { describe, expect, it } from "vitest";
import { ALIAS_CONCEPTS, buildDictionary, GLOSSARY, matchConcept } from "./glossary";

const dictionary = buildDictionary();

describe("glossary data (spec 10.2)", () => {
  it("has only known concepts, and no one-word Banglish spelling for two targets", () => {
    const owner = new Map<string, string>();
    for (const entry of GLOSSARY) {
      expect(ALIAS_CONCEPTS).toContain(entry.target_concept);
      for (const spelling of entry.latin.filter((word) => !/\s/.test(word))) {
        const target = `${entry.target_concept}:${entry.target_value}`;
        expect(owner.get(spelling) ?? target, spelling).toBe(target);
        owner.set(spelling, target);
      }
    }
  });
});

describe("matching (spec 10.2, 10.3)", () => {
  it("resolves the architecture's example: sell heard, self in hypothesis 2", () => {
    const match = matchConcept("part_type", "সেল", ["নোয়ার সেল আছে", "নোয়ার সেলফ আছে"], dictionary);
    expect(match.candidates[0]).toMatchObject({ value: "Starter Motor", exact: true });
    expect(match.candidates[0]?.score).toBeCloseTo(0.95, 5);
    expect(match.decision).toBe("understood");
  });

  it("matches a word with its grammatical ending and a Banglish spelling variant", () => {
    expect(matchConcept("vehicle_model", "নোয়ার", [], dictionary).candidates[0]).toMatchObject({
      value: "Toyota Noah",
      exact: true,
    });
    expect(matchConcept("position", "shamne", [], dictionary).candidates[0]?.value).toBe("front");
    expect(matchConcept("part_type", "mobil filter", [], dictionary).candidates[0]?.value).toBe("Oil Filter");
  });

  it("takes words of other hypotheses only where they sound like the said value", () => {
    const match = matchConcept("vehicle_model", "axio", ["axio 2014 e fit hobe"], dictionary);
    expect(match.candidates[0]).toMatchObject({ value: "Toyota Axio", score: 1 });
    expect(match.candidates.map((candidate) => candidate.value)).not.toContain("Honda Fit");
    expect(match.decision).toBe("understood");
  });

  it("matches a near spelling phonetically, and leaves a far one unclear", () => {
    const near = matchConcept("vehicle_model", "premiyo", [], dictionary);
    expect(near.candidates[0]?.value).toBe("Toyota Premio");
    expect(near.candidates[0]?.exact).toBe(false);
    expect(matchConcept("part_type", "xyzzy", [], dictionary).decision).toBe("unclear");
  });

  // From the first voice test on the emulator (D101): Whisper wrote "এক্সিও" as "এক জিও", and "এক" (one) sounds like
  // Aqua's "একুয়া".
  it("understands Axio as Whisper splits it, and never takes a number word for a car", () => {
    const heard = "এক জিও দুই হাজার চৌদ্দ এর সামনে ব্রেকপ্যান আছে";
    const axio = matchConcept("vehicle_model", heard, [], dictionary);
    expect(axio.decision).toBe("understood");
    expect(axio.candidates[0]).toMatchObject({ value: "Toyota Axio", exact: true });
    const aqua = axio.candidates.find((candidate) => candidate.value === "Toyota Aqua");
    expect(aqua?.score ?? 0).toBeLessThan(0.7);
    for (const said of ["এক", "ek", "হাজার", "hajar", "দুই হাজার চৌদ্দ", "dui hajar choddo"]) {
      expect(matchConcept("vehicle_model", said, [], dictionary).candidates, said).toEqual([]);
    }
  });

  it.each([
    { style: "Bangla", said: "এক সি ও দুই হাজার চৌদ্দ" },
    { style: "Banglish", said: "axio dui hajar choddo" },
  ])("understands Axio with a year said in words ($style)", ({ said }) => {
    const match = matchConcept("vehicle_model", said, [], dictionary);
    expect(match.decision).toBe("understood");
    expect(match.candidates[0]?.value).toBe("Toyota Axio");
  });
});
