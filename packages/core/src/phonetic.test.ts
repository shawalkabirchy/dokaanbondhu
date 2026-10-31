import { describe, expect, it } from "vitest";
import { optionBySound } from "./phonetic";

// D211: a short spoken answer matched to a button of fixed words by its sound, in Bangla and in Banglish (D96).

const KINDS = [{ label: "খুচরা" }, { label: "পাইকারি" }];
const label = (guesses: string[], options = KINDS) => optionBySound(guesses, options)?.label ?? null;

describe("optionBySound (D211)", () => {
  it.each([
    ["পাইকারী", "পাইকারি"],
    ["পাইকার ই", "পাইকারি"],
    ["pikari", "পাইকারি"],
    ["paikary", "পাইকারি"],
    ["খুশরা", "খুচরা"],
    ["কুচরা", "খুচরা"],
    ["khushra", "খুচরা"],
    ["kuchra", "খুচরা"],
  ])("reads %s as %s", (guess, word) => {
    expect(label([guess])).toBe(word);
  });

  it("goes on to the next guess, best first", () => {
    expect(label(["ফাইনাল", "পাইকারি", "খুচরা"])).toBe("পাইকারি");
    expect(label(["final", "khuchra", "paikari"])).toBe("খুচরা");
  });

  it.each([["জানি না"], ["jani na"], ["সেলিম অটো"], ["Selim Auto"], [""]])(
    "leaves %j to the question",
    (guess) => {
      expect(label([guess])).toBeNull();
    },
  );

  it("takes no answer of more than two words", () => {
    expect(label(["পাইকারী দাম কত"])).toBeNull();
    expect(label(["paikari dam koto"])).toBeNull();
  });

  it("takes neither of two buttons that sound alike", () => {
    expect(label(["পাইকারি"], [{ label: "পাইকারি" }, { label: "পাইকারী" }])).toBeNull();
    expect(label(["rahim"], [{ label: "Rahim" }, { label: "Rahima" }])).toBeNull();
  });

  it("gives back the button itself, with its value", () => {
    const options = [
      { label: "বাকিতে", value: "credit" },
      { label: "নগদে", value: "cash" },
    ];
    expect(optionBySound(["বাকীতে"], options)?.value).toBe("credit");
    expect(optionBySound(["নোগদে"], options)?.value).toBe("cash");
  });
});
