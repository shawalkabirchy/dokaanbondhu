import { describe, expect, it } from "vitest";
import {
  confirmationText,
  daysAgoSaid,
  decisionOf,
  methodText,
  parseAmount,
  paymentText,
  refundText,
  refusalText,
  saidMoney,
  saidNumbers,
  saysDamaged,
  saysWalkIn,
  writeCueOf,
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
        tier: "paikari",
        oldPrice: 4200n,
        newPrice: 4400n,
      }),
    ).toBe("ব্রেক প্যাডের পাইকারি দাম ৪,২০০ টাকা থেকে ৪,৪০০ টাকা। ঠিক আছে?");
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

describe("what asks for a write (D140)", () => {
  it.each([
    ["রহিম মোটরসকে এক্সিওর সামনের ব্রেক প্যাড বাকিতে দাও", true, "sale"],
    ["Rahim Motors ke axior samner brake pad bakite dao", true, "sale"],
    ["এক সেট প্যাড নগদে দাও", false, "sale"],
    ["ek set pad nogode dao", false, "sale"],
    ["রহিম থেকে ১০ হাজার টাকা জমা নাও", false, "payment"],
    ["Rahim theke 10 hajar taka joma nao", false, "payment"],
    ["নবাবপুর থেকে ৫ সেট প্যাড কিনলাম", true, "stock_in"],
    ["Nawabpur theke 5 set pad kinlam", true, "stock_in"],
  ] as const)("%s is a %s", (text, partyNamed, kind) => {
    expect(writeCueOf(text, { partyNamed })).toBe(kind);
  });

  it.each([
    ["প্যাডটা দাও", false],
    ["padta dao", false],
    ["রহিম মোটরসকে প্যাডের দাম দাও", true],
    ["Rahim Motors ke pad er dam dao", true],
    ["রহিম মোটরসের বাকি কত?", true],
    ["Rahim Motors er baki koto?", true],
    ["আজ কত জমা হলো", false],
    ["aj koto joma holo", false],
  ] as const)("%s asks no write", (text, partyNamed) => {
    expect(writeCueOf(text, { partyNamed })).toBeNull();
  });
});

describe("money said (D157)", () => {
  it.each([
    { style: "Bangla", text: "পাঁচ সেট কিনলাম, প্রতি সেট ১২০০ টাকা, বাকিতে", money: [1200] },
    { style: "Banglish", text: "5 set kinlam, proti set 1200 taka, bakite", money: [1200] },
    { style: "Bangla", text: "রহিম থেকে দশ হাজার টাকা জমা নাও", money: [10_000] },
    { style: "Banglish", text: "rahim theke 10 hajar taka joma nao", money: [10_000] },
    // সেট heard as সেন্ট on 11 Oct: a quantity is never money
    { style: "Bangla", text: "এক্সিও সামনের নন জেনুইন ব্রেক প্যাড পাঁচ সেন্ট কিনলাম", money: [] },
    { style: "Banglish", text: "axio samner non genuine brake pad 5 cent kinlam", money: [] },
  ])("takes only an amount said as money ($style: $text)", ({ text, money }) => {
    expect([...saidMoney(text)]).toEqual(money);
  });
});

describe("numbers said", () => {
  it("reads every number a request says, in either script", () => {
    expect([...saidNumbers("এক্সিও ২০১৪ সামনের প্যাড দুই সেট")]).toEqual(expect.arrayContaining([2014, 2]));
    expect([...saidNumbers("axio 2014 samner pad dui set")]).toEqual(expect.arrayContaining([2014, 2]));
    expect([...saidNumbers("10 hajar taka joma nao")]).toEqual(expect.arrayContaining([10_000]));
    expect([...saidNumbers("১০,০০০ টাকা")]).toEqual(expect.arrayContaining([10_000]));
    expect([...saidNumbers("দুইটা প্লাগ দাও")]).toEqual(expect.arrayContaining([2]));
    expect(saidNumbers("রহিম মোটরসকে প্যাড বাকিতে দাও").size).toBe(0);
  });
});

describe("a return said (D169)", () => {
  it.each([
    ["রহিম মোটরস এক্সিওর সামনের ব্রেক প্যাড এক সেট ফেরত দিয়েছে", true],
    ["Rohim Motors axio r samner brake pad ek set ferot dise", true],
    ["একটা প্লাগ ফেরত নাও", false],
    ["ekta plug ferot nao", false],
    ["রহিমকে ব্রেক প্যাড ফেরত দাও", true],
    ["brake pad return nilam", false],
  ] as const)("%s is a return, never a sale", (text, partyNamed) => {
    expect(writeCueOf(text, { partyNamed })).toBe("return");
  });

  it.each(["ব্রেক প্যাড ফেরত দেওয়া যাবে?", "brake pad ferot deya jabe?"])(
    "%s asks, and is no return",
    (text) => {
      expect(writeCueOf(text, { partyNamed: false })).toBeNull();
    },
  );

  it.each([
    ["আজ বিক্রি করা প্যাড", 0],
    ["aj er pad", 0],
    ["গতকাল নিয়েছিল", 1],
    ["gotokal nise", 1],
    ["পরশু কিনেছে", 2],
    ["porshu kinse", 2],
    ["৩ দিন আগে", 3],
    ["3 din age", 3],
    ["পাঁচ দিন আগে", 5],
    ["panch din age", 5],
  ] as const)("the sale's day in %s is %i days ago", (text, days) => {
    expect(daysAgoSaid(text)).toBe(days);
  });

  it("says no day when none is said", () => {
    expect(daysAgoSaid("রহিম মোটরস প্যাড ফেরত দিল")).toBeNull();
    expect(daysAgoSaid("Rohim Motors pad ferot dilo")).toBeNull();
  });

  it("hears a damaged part and a walk-in buyer, in Bangla and Banglish", () => {
    expect(saysDamaged("প্যাডটা নষ্ট, ফেরত নাও")).toBe(true);
    expect(saysDamaged("padta kharap, ferot nao")).toBe(true);
    expect(saysDamaged("প্যাড ফেরত নাও")).toBe(false);
    expect(saysWalkIn("নাম ছাড়া")).toBe(true);
    expect(saysWalkIn("walk in")).toBe(true);
    expect(saysWalkIn("nam chara")).toBe(true);
    expect(saysWalkIn("রহিম মোটরস")).toBe(false);
  });

  it("says how the money goes back", () => {
    expect(refundText(1600n, 0n)).toBe("বাকি থেকে কাটা হবে");
    expect(refundText(0n, 1600n)).toBe("নগদ ফেরত");
    expect(refundText(1000n, 600n)).toBe("বাকি থেকে ১,০০০ টাকা, নগদ ৬০০ টাকা");
  });

  it("confirms with the sale's day before the part", () => {
    expect(
      confirmationText("return", {
        customer: "Rahim Motors",
        date: "১৪ অক্টোবরের",
        lines: [
          {
            vehicle: "Toyota Axio",
            year: 2014,
            position: "front",
            part: "ব্রেক প্যাড",
            quality: "genuine",
            quantity: "১ সেট",
          },
        ],
        total: 4500n,
        refund: refundText(4500n, 0n),
      }),
    ).toBe(
      "Rahim Motors — ১৪ অক্টোবরের এক্সিও ২০১৪, সামনের ব্রেক প্যাড, জেনুইন, ১ সেট, ৪,৫০০ টাকা ফেরত, বাকি থেকে কাটা হবে। ঠিক আছে?",
    );
  });
});
