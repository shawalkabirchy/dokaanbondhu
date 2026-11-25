import { describe, expect, it } from "vitest";
import { isRackWord, parseAmount, writeCueOf } from "./actions";
import { saysOne } from "./quantity";
import { asksNoneLeft, isWhoWord, reminderCueOf } from "./reminders";
import { normalize } from "./text";

// The readers the final evaluation's held-out misses asked for (D257), in Bangla and in Banglish (D96).

describe("the write said (D257)", () => {
  it.each([
    { style: "Bangla", text: "দুইটা প্রিমিওর জেনুইন সামনের ব্রেক প্যাড মাল উঠান ৩৫০০ করে" },
    { style: "Banglish", text: "duita premio er genuine samner brake pad mal uthan 3500 kore" },
  ])("“mal uthan” is stock coming in ($style)", ({ text }) => {
    expect(writeCueOf(text, { partyNamed: false })).toBe("stock_in");
  });
  it.each([
    { style: "Bangla", text: "লিখে রাখো ৯০৯১৫ পার্টটা হায়েসেও লাগে" },
    { style: "Banglish", text: "likhe rakho 90915 part ta hiace eo lage" },
  ])("a fitment written down is a fitment, never a rack change ($style)", ({ text }) => {
    expect(writeCueOf(text, { partyNamed: false })).toBe("add_fitment");
  });
  it.each([
    { style: "Bangla", text: "ব্রেক প্যাডটা বি-৩ এ রাখো" },
    { style: "Banglish", text: "brake pad ta B-3 e rakho" },
  ])("a part put on a rack is still a rack change ($style)", ({ text }) => {
    expect(writeCueOf(text, { partyNamed: false })).toBe("rack_update");
  });
  it.each([
    { style: "Bangla", words: ["রেক", "রেকে", "সরিয়ে", "রাখো"] },
    { style: "Banglish", words: ["rack", "racke", "soriye", "rakho"] },
  ])("a rack change's words are rack words ($style)", ({ words }) => {
    for (const word of words) expect(isRackWord(word), word).toBe(true);
    expect(isRackWord("ফিল্ডার")).toBe(false);
  });
});

describe("money and how many (D257)", () => {
  it.each([
    { style: "Bangla", text: "প্রত্যেকটা দুঃশ পঞ্চাশ টাকার দামে", taka: 250 },
    { style: "Banglish", text: "prottekta dui sho ponchash takar dame", taka: 250 },
  ])("two hundred as speech writes it ($style)", ({ text, taka }) => {
    expect(parseAmount(text)).toBe(taka);
  });
  it.each([
    {
      style: "Bangla",
      one: "সুমন মিয়া সামনের ব্রেক প্যাটটা ফেরত দিছে",
      two: "সুমন মিয়া দুইটা ব্রেক প্যাড ফেরত দিছে",
    },
    {
      style: "Banglish",
      one: "sumon mia samner brake pad ta ferot dise",
      two: "sumon mia duita brake pad ferot dise",
    },
  ])("“the” part is one; a number said is not ($style)", ({ one, two }) => {
    expect(saysOne(normalize(one).tokens)).toBe(true);
    expect(saysOne(normalize(two).tokens)).toBe(false);
  });
});

describe("reminders asked other ways (D257)", () => {
  it.each([
    {
      style: "Bangla",
      soon: "কোন কোন মাল শেষের দিকে?",
      none: "কোন মাল একদম শেষ?",
      old: "পুরনো বাকি কার কার?",
    },
    {
      style: "Banglish",
      soon: "kon kon mal shesher dike?",
      none: "kon mal ekdom shesh?",
      old: "purono baki kar kar?",
    },
  ])("almost out, none left, and whose dues ($style)", ({ soon, none, old }) => {
    expect(reminderCueOf(soon)).toBe("low_stock");
    expect(asksNoneLeft(soon)).toBe(false);
    expect(reminderCueOf(none)).toBe("low_stock");
    expect(asksNoneLeft(none)).toBe(true);
    expect(reminderCueOf(old)).toBe("old_dues");
  });
  it.each([
    { style: "Bangla", who: "কার কার", name: "করিম অটো" },
    { style: "Banglish", who: "kar kar", name: "Karim Auto" },
  ])("a “who” word is no name ($style)", ({ who, name }) => {
    expect(isWhoWord(who)).toBe(true);
    expect(isWhoWord(name)).toBe(false);
  });
});
