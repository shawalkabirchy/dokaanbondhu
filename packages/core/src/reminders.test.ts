import { describe, expect, it } from "vitest";
import { lowStockAnswer, oldDuesAnswer, reminderCueOf } from "./reminders";

// D194: a reminder asked in Bangla or in Banglish, and its answers.

describe("a reminder asked for", () => {
  it.each([
    ["কী কী কম আছে?", "low_stock"],
    ["কোন কোন পার্ট কম পড়েছে", "low_stock"],
    ["কোনগুলো ফুরিয়ে যাচ্ছে?", "low_stock"],
    ["কী অর্ডার দিতে হবে?", "low_stock"],
    ["ki ki kom ache?", "low_stock"],
    ["kon kon part furiye jacche", "low_stock"],
    ["low stock dekhao", "low_stock"],
    ["কার বাকি পুরোনো?", "old_dues"],
    ["পুরনো বাকি কার কার?", "old_dues"],
    ["অনেক দিনের বাকি কারা দেয়নি", "old_dues"],
    ["kar baki purono?", "old_dues"],
    ["purano baki kader", "old_dues"],
    ["overdue customer dekhao", "old_dues"],
  ])("%s is %s", (text, kind) => {
    expect(reminderCueOf(text)).toBe(kind);
  });

  it.each([
    "এক্সিওর সামনের প্যাড আছে?",
    "রহিম মোটরসের বাকি কত?",
    "axio front pad ache?",
    "rahim motors er baki koto?",
    "",
  ])("%s asks for none", (text) => {
    expect(reminderCueOf(text)).toBeNull();
  });
});

describe("the reminders' answers", () => {
  it("say how many parts are low, with their names when few and in Bangla", () => {
    expect(
      lowStockAnswer([
        { name: "Starter Motor", nameBn: "সেলফ মোটর", stock: 0 },
        { name: "Alternator", nameBn: "ডায়নামো", stock: 1 },
      ]),
    ).toBe("২টি পার্ট কম আছে: সেলফ মোটর, ডায়নামো। বিস্তারিত স্ক্রিনে দেখুন।");
    expect(lowStockAnswer([{ name: "Horn Set", nameBn: null, stock: 0 }])).toBe(
      "১টি পার্ট কম আছে। বিস্তারিত স্ক্রিনে দেখুন।",
    );
    expect(lowStockAnswer([])).toBe("এখন কোনো পার্ট কম নেই।");
  });

  it("say how many owe for long and the old total", () => {
    expect(
      oldDuesAnswer([
        { name: "Rahim Motors", nameBn: null, due: 21900n, old: 11320n },
        { name: "Karim Auto", nameBn: null, due: 4000n, old: 4000n },
      ]),
    ).toBe("২ জনের বাকি ৩০ দিনের বেশি পুরোনো, মোট ১৫,৩২০ টাকা। বিস্তারিত স্ক্রিনে দেখুন।");
    expect(oldDuesAnswer([{ name: "Rahim Motors", nameBn: "রহিম মোটরস", due: 500n, old: 500n }])).toBe(
      "১ জনের বাকি ৩০ দিনের বেশি পুরোনো, মোট ৫০০ টাকা: রহিম মোটরস। বিস্তারিত স্ক্রিনে দেখুন।",
    );
    expect(oldDuesAnswer([])).toBe("৩০ দিনের বেশি পুরোনো বাকি কারো নেই।");
  });
});
