import { describe, expect, it } from "vitest";
import {
  confirmationText,
  decisionOf,
  methodText,
  parseAmount,
  paymentText,
  refusalText,
  resultText,
} from "./actions";

// The write path's words (spec 9.9, 11.10; D135), each spoken form in Bangla and in Banglish (D96).

describe("amounts as said", () => {
  it.each([
    ["১০ হাজার", 10_000],
    ["10 hajar", 10_000],
    ["১০,০০০ টাকা", 10_000],
    ["10,000 taka", 10_000],
    ["দশ হাজার পাঁচশো", 10_500],
    ["dosh hajar pachsho", 10_500],
    ["এক লাখ বিশ হাজার", 1_20_000],
    ["ek lakh bish hajar", 1_20_000],
    ["1,00,000", 1_00_000],
    ["দেড় হাজার", 1_500],
    ["der hajar", 1_500],
    ["৪২০০", 4_200],
    ["তিনশো টাকা", 300],
    ["tinsho taka", 300],
  ])("%s is %d taka", (said, taka) => {
    expect(parseAmount(said)).toBe(taka);
  });

  it("finds none in words without a number, and none that is not whole taka", () => {
    expect(parseAmount("জমা নাও")).toBeNull();
    expect(parseAmount("joma nao")).toBeNull();
    expect(parseAmount("12.5")).toBeNull();
  });
});

describe("yes and no", () => {
  it.each([
    "হ্যাঁ",
    "ha",
    "haaa",
    "জ্বি",
    "ji",
    "ঠিক আছে",
    "thik ache",
    "হ্যাঁ, ঠিক আছে",
    "ha thik ache",
    "ওকে",
    "ok",
  ])("%s is yes", (said) => expect(decisionOf(said)).toBe("yes"));
  it.each(["না", "na", "না না", "na na", "বাতিল", "batil", "থাক", "thak", "cancel"])("%s is no", (said) =>
    expect(decisionOf(said)).toBe("no"),
  );
  it.each(["না, দুই সেট", "na, dui set", "হ্যাঁ দুই সেট দাও", "ha dui set dao", "জেনুইন", "genuine", ""])(
    "%s is neither: a correction attempt",
    (said) => expect(decisionOf(said)).toBeNull(),
  );
});

describe("confirmation templates", () => {
  it("says a credit sale as A.6 does", () => {
    const text = confirmationText("sale", {
      customer: "রহিম মোটরস",
      lines: [
        {
          vehicle: "Toyota Axio",
          year: 2014,
          position: "front",
          part: "ব্রেক প্যাড",
          quality: "aftermarket",
          quantity: "২ সেট",
        },
      ],
      total: 3200n,
      payment: paymentText([], 3200n),
    });
    expect(text).toBe(
      "রহিম মোটরস — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?",
    );
  });

  it("says a payment as A.3 does, and the payment of a sale paid in cash or by a method", () => {
    expect(
      confirmationText("payment", { customer: "রহিম মোটরস", amount: 10_000n, payment: methodText("cash") }),
    ).toBe("রহিম মোটরস থেকে ১০,০০০ টাকা জমা, নগদ। ঠিক আছে?");
    expect(paymentText([{ method: "cash", amount: 4200n }], 4200n)).toBe("নগদ");
    expect(paymentText([{ method: "bkash", amount: 2000n }], 4200n)).toBe("বিকাশ ২,০০০ টাকা");
    expect(methodText("other_wallet")).toBe("other_wallet");
  });

  it("says a stock-in, a walk-in sale, and the other kinds", () => {
    expect(
      confirmationText("stock_in", {
        supplier: "ইস্টার্ন লুব্রিকেন্টস",
        lines: [{ part: "মবিল", quantity: "১০ লিটার", unit: "লিটার", unitCost: 450n }],
        total: 4500n,
      }),
    ).toBe("ইস্টার্ন লুব্রিকেন্টস থেকে মবিল, ১০ লিটার, প্রতি লিটার ৪৫০ টাকা, মোট ৪,৫০০ টাকা। ঠিক আছে?");
    expect(
      confirmationText("sale", {
        lines: [{ part: "প্লাগ", quantity: "৪টা" }],
        total: 1200n,
        payment: paymentText([{ method: "cash", amount: 1200n }], 1200n),
      }),
    ).toBe("প্লাগ, ৪টা, ১,২০০ টাকা, নগদ। ঠিক আছে?");
    expect(
      confirmationText("return", {
        customer: "করিম অটো",
        date: "গতকাল",
        lines: [{ position: "front", part: "ব্রেক প্যাড", quality: "aftermarket", quantity: "১ সেট" }],
        total: 1600n,
        refund: "বাকি থেকে কাটা হবে",
      }),
    ).toBe(
      "করিম অটো — গতকাল সামনের ব্রেক প্যাড, নন-জেনুইন, ১ সেট, ১,৬০০ টাকা ফেরত, বাকি থেকে কাটা হবে। ঠিক আছে?",
    );
    expect(
      confirmationText("price_update", {
        lines: [{ part: "ব্রেক প্যাড" }],
        tier: "garage",
        oldPrice: 4200n,
        newPrice: 4400n,
      }),
    ).toBe("ব্রেক প্যাডের গ্যারেজ দাম ৪,২০০ টাকা থেকে ৪,৪০০ টাকা। ঠিক আছে?");
    expect(confirmationText("generic", { label: "অর্ডার", pairs: [{ label: "নম্বর", value: "১২" }] })).toBe(
      "অর্ডার, নম্বর: ১২। ঠিক আছে?",
    );
  });
});

describe("result templates", () => {
  it("says what was done with the balance from the host, and the rack of a sale's part", () => {
    expect(
      resultText("done", "sale", { customer: "রহিম মোটরস", due: 23_400n, part: "প্যাডটা", rack: "B-3" }),
    ).toBe("হয়ে গেছে। রহিম মোটরসের মোট বাকি এখন ২৩,৪০০ টাকা। প্যাডটা B-3 তাকে আছে।");
    expect(resultText("done", "payment", { customer: "রহিম মোটরস", due: 13_400n })).toBe(
      "জমা হয়েছে। রহিম মোটরসের বাকি এখন ১৩,৪০০ টাকা।",
    );
    expect(resultText("done", "stock_in", { supplier: "ইস্টার্ন লুব্রিকেন্টস", payable: 9000n })).toBe(
      "হয়ে গেছে। ইস্টার্ন লুব্রিকেন্টসের পাওনা এখন ৯,০০০ টাকা।",
    );
  });

  it("leaves out a sentence whose value the host did not give", () => {
    expect(resultText("done", "sale", { customer: "রহিম মোটরস" })).toBe("হয়ে গেছে।");
    expect(resultText("done", "price_update")).toBe("হয়ে গেছে।");
  });

  it("says failed, review, cancelled and undone", () => {
    expect(resultText("failed", "sale", { reason: "স্টকে যথেষ্ট নেই।" })).toBe(
      "কাজটা হয়নি। স্টকে যথেষ্ট নেই।",
    );
    expect(resultText("failed", "sale", { reason: refusalText(422) })).toBe(
      "কাজটা হয়নি। অ্যাপ তথ্যগুলো নেয়নি।",
    );
    expect(resultText("review", "sale")).toBe("সেভ হয়েছে কিনা নিশ্চিত না। ইতিহাসে দেখে নিন।");
    expect(resultText("cancelled", "sale")).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
    expect(resultText("expired", "payment")).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
    expect(resultText("undone", "sale", { customer: "রহিম মোটরস", due: 20_200n })).toBe(
      "আগের কাজটা ফিরিয়ে নেওয়া হয়েছে। রহিম মোটরসের মোট বাকি এখন ২০,২০০ টাকা।",
    );
  });
});
