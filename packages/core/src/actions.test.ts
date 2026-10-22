import { describe, expect, it } from "vitest";
import {
  alsoCarWords,
  confirmationText,
  customerKindOf,
  daysAgoSaid,
  decisionOf,
  methodText,
  ownerOnlyText,
  parseAmount,
  paymentText,
  phoneOf,
  phoneText,
  refundText,
  refusalText,
  saidMoney,
  saidNumbers,
  salePriceOf,
  saysSalePrice,
  saysDamaged,
  saysNewParty,
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

describe("a quantity glued as speech-to-text writes it (D170)", () => {
  it.each([
    ["Rohim Motors brake pad exet ferot dise", 1],
    ["রহিম মোটরস ব্রেক প্যাড এক্সেট ফেরত দিয়েছে", 1],
    ["Rahim Motors ke duiset pad bakite dao", 2],
    ["রহিম মোটরসকে দুইসেট প্যাড বাকিতে দাও", 2],
  ] as const)("%s says %i", (text, value) => {
    expect(saidNumbers(text).has(value)).toBe(true);
  });
});

describe("a price change said (D171)", () => {
  it.each([
    "নোয়ার সেলফ মোটরের দাম ৮৫০০ টাকা করো",
    "Noah er self er dam 8500 koro",
    "এক্সিওর ব্রেক প্যাডের পাইকারি দাম ১৪০০ করে দাও",
    "axio r brake pad er paikari dam 1400 kore dao",
    "ব্রেক প্যাডের দাম আট হাজার পাঁচশো রাখো",
    "brake pad er dam 8500 rakho",
    // The polite forms (D188).
    "AN-136WK এর খুচরা দাম ১৭০০ করে দেন",
    "AN-136WK er khuchra dam 1700 kore den",
  ])("%s is a price change", (text) => {
    expect(writeCueOf(text, { partyNamed: false })).toBe("price_update");
  });

  it.each([
    "নোয়ার সেলফ মোটরের দাম কত?",
    "Noah er self er dam koto?",
    "এক্সিওর প্যাডের দাম কত করো", // a question word
    "axio pad er dam koto koro",
    "রহিম মোটরসকে প্যাডের দাম দাও", // no amount, no word that sets it
    "Rahim Motors ke pad er dam dao",
    "প্যাড ৪৫০০ টাকা দামে বিক্রি করো", // a sale, never a price change
    "pad 4500 taka dam e bikri koro",
  ])("%s is no price change", (text) => {
    expect(writeCueOf(text, { partyNamed: false })).not.toBe("price_update");
  });

  it("tells staff only the owner may", () => {
    expect(ownerOnlyText("price_update")).toBe("দাম বদলাতে পারেন শুধু দোকানের মালিক।");
    expect(ownerOnlyText("generic")).toBe("এটা শুধু দোকানের মালিক করতে পারেন।");
  });

  it("confirms the price from and to", () => {
    expect(
      confirmationText("price_update", {
        lines: [{ part: "নোয়ার সেলফ মোটর" }],
        tier: "retail",
        oldPrice: 8200n,
        newPrice: 8500n,
      }),
    ).toBe("নোয়ার সেলফ মোটরের খুচরা দাম ৮,২০০ টাকা থেকে ৮,৫০০ টাকা। ঠিক আছে?");
  });
});

describe("a fitment said (D172)", () => {
  it.each([
    "এই প্যাডটা প্রিমিওতেও লাগে",
    "ei pad ta premio teo lage",
    "এক্সিওর সামনের ব্রেক প্যাড ফিল্ডারেও লাগে",
    "axio r samner brake pad fielder eo lage",
    "এই প্যাডটা প্রিমিও ২০০৯-এ লাগে, লিখে রাখো",
    "ei pad ta premio 2009 e lage, likhe rakho",
    "ei pad premio te o lage",
  ])("%s adds a fitment", (text) => {
    expect(writeCueOf(text, { partyNamed: false })).toBe("add_fitment");
  });

  it.each([
    "এই প্যাডটা প্রিমিওতে লাগবে?",
    "ei pad ta premio te lagbe?",
    "প্রিমিওতে লাগে কিনা",
    "premio te lage kina",
    "প্রিমিওর প্যাড লাগে", // no "also", nothing to record: a part asked for
    "premio r pad lage",
  ])("%s adds none", (text) => {
    expect(writeCueOf(text, { partyNamed: false })).not.toBe("add_fitment");
  });
});

describe("a new customer or supplier said (D173)", () => {
  it.each([
    ["নতুন কাস্টমার যোগ করো, রহিম গ্যারেজ", "add_customer"],
    ["notun customer jog koro, Rahim Garage", "add_customer"],
    ["রহিম গ্যারেজ নামে নতুন গ্যারেজ অ্যাড করো", "add_customer"],
    ["Rahim Garage name e notun garage add koro", "add_customer"],
    ["নতুন কাস্টমার যোগ করে দিন", "add_customer"],
    ["notun customer jog kore din", "add_customer"],
    ["নতুন সাপ্লায়ার যোগ করো, ঢাকা অটো", "add_supplier"],
    ["notun supplier add koro, Dhaka Auto", "add_supplier"],
  ] as const)("%s is %s", (text, kind) => {
    expect(writeCueOf(text, { partyNamed: false })).toBe(kind);
  });

  it.each([
    "নতুন কাস্টমার রহিমকে দুই সেট প্যাড বাকিতে দাও", // a sale to a new name: the sale asks to add it
    "notun customer Rahim ke dui set pad bakite dao",
    "নতুন কাস্টমার কয়জন?",
    "notun customer koyjon?",
    "কাস্টমার যোগ করো", // নতুন is not said
    "customer jog koro",
  ])("%s adds none", (text) => {
    expect(["add_customer", "add_supplier"]).not.toContain(writeCueOf(text, { partyNamed: false }));
  });

  it.each([
    ["০১৭১১২২৩৩৪৪", "01711223344"],
    ["01711-223344", "01711223344"],
    ["০১৭১১ ২২৩ ৩৪৪", "01711223344"],
    ["+8801711223344", "01711223344"],
    ["amar number 01911 000000", "01911000000"],
    ["শূন্য এক সাত এক এক দুই দুই তিন তিন চার চার", "01711223344"],
    ["zero one seven double one two two three three four four", "01711223344"],
    ["জিরো ওয়ান এইট ওয়ান ওয়ান দুই দুই তিন তিন চার চার", "01811223344"],
    ["নেই", "none"],
    ["nei", "none"],
    ["ফোন নাই", "none"],
    ["phone nai", "none"],
    ["০১২৩৪", null],
    ["01211223344", null], // no operator starts 012
    ["kal dibo", null],
  ] as const)("phone %s is %s", (text, phone) => {
    expect(phoneOf(text)).toBe(phone);
  });

  it("shows a phone in Bangla digits with a dash", () => {
    expect(phoneText("01711223344")).toBe("০১৭১১-২২৩৩৪৪");
  });

  it.each([
    ["খুচরা", "retail"],
    ["khuchra", "retail"],
    ["পাইকারি", "paikari"],
    ["paikari", "paikari"],
    ["গ্যারেজ", "paikari"],
    ["garage", "paikari"],
    ["মিস্ত্রি", "paikari"],
    ["dealer", "paikari"],
    ["জানি না", null],
  ] as const)("the kind %s is %s", (text, kind) => {
    expect(customerKindOf(text)).toBe(kind);
  });

  it("does not take গ্যারেজ in a request for a kind, since names hold it", () => {
    expect(customerKindOf("রহিম গ্যারেজ নামে নতুন কাস্টমার যোগ করো", { inRequest: true })).toBeNull();
    expect(customerKindOf("Rahim Garage notun customer, paikari", { inRequest: true })).toBe("paikari");
  });

  it.each(["নতুন হিসেবে যোগ করুন", "নতুন", "notun", "notun hishebe jog korun"])(
    "%s adds the name",
    (text) => {
      expect(saysNewParty(text)).toBe(true);
    },
  );

  it("confirms a new customer and a new supplier, and says each is added", () => {
    expect(
      confirmationText("add_customer", { name: "রহিম গ্যারেজ", kind: "paikari", phone: "01711223344" }),
    ).toBe("নতুন কাস্টমার: রহিম গ্যারেজ, পাইকারি, ০১৭১১-২২৩৩৪৪। যোগ করব?");
    expect(confirmationText("add_supplier", { name: "Dhaka Auto" })).toBe(
      "নতুন সাপ্লায়ার: Dhaka Auto। যোগ করব?",
    );
    expect(resultText("done", "add_customer", { name: "রহিম গ্যারেজ" })).toBe("রহিম গ্যারেজ যোগ হয়েছে।");
    expect(resultText("done", "add_supplier", { name: "Dhaka Auto" })).toBe("Dhaka Auto যোগ হয়েছে।");
  });
});

describe("the car a fitment adds, said with “also” (D174)", () => {
  it.each([
    ["এই প্যাটটা প্রিমিওতেও লাগে", /প্রিমিও$/],
    ["ei pat ta premio teo lage", /premio$/],
    ["এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড ফিল্ডারেও লাগে", /ফিল্ডার$/],
    ["axio 2014 er samner brake pad fielder eo lage", /fielder$/],
    ["ei pad premio te o lage", /premio$/],
    ["ei pad ta premioteo lage", /premio$/],
    ["এই প্যাডটা প্রিমিও ২০০৯-তেও লাগে", /প্রিমিও 2009$/],
    ["ei pad ta premio 2009 teo lage", /premio 2009$/],
  ] as const)("%s names it", (text, car) => {
    expect(alsoCarWords(text)).toMatch(car);
  });

  it.each(["প্রিমিওর প্যাড লাগে", "premio r pad lage", "এই প্যাডটা আছে?"])("%s names none", (text) => {
    expect(alsoCarWords(text)).toBeNull();
  });
});

describe("a sale's price said (D176, D177)", () => {
  it.each([
    ["রহিম মোটরসকে দুই সেট ব্রেক প্যাড ৩০০০ টাকায় দাও", 3000, false],
    ["Rahim Motors ke dui set brake pad 3000 takay dao", 3000, false],
    ["তিন হাজার টাকায় দাও", 3000, false],
    ["3,000 takai dao", 3000, false],
    ["দুই সেট প্যাড ৩০০০ টাকা দামে দাও", 3000, false],
    ["দুই সেট ১৫০০ টাকা করে দাও", 1500, true],
    ["dui set 1500 taka kore dao", 1500, true],
    ["প্রতি সেট ১৫০০ টাকা দাও", 1500, true],
    ["proti set 1500 taka dao", 1500, true],
  ] as const)("%s sets %d (each: %s)", (text, amount, each) => {
    expect(salePriceOf(text)).toEqual({ amount, each });
  });

  it.each([
    "দুই সেট দাও, ২০০০ টাকা নগদ দিল", // a payment's amount
    "dui set dao, 2000 taka nogod dilo",
    "পাঁচ করে দাও", // a quantity, not money
    "1500 kore dao",
    "রহিম মোটরসকে দুই সেট প্যাড বাকিতে দাও",
  ])("%s sets none", (text) => {
    expect(salePriceOf(text)).toBeNull();
  });

  it("says the price of one after the quantity", () => {
    expect(
      confirmationText("sale", {
        customer: "Rahim Motors",
        lines: [{ part: "ব্রেক প্যাড", quantity: "২ সেট", unit: "সেট", unitPrice: 1500n }],
        total: 3000n,
        payment: "বাকিতে",
      }),
    ).toBe("Rahim Motors — ব্রেক প্যাড, ২ সেট, প্রতি সেট ১,৫০০ টাকা, ৩,০০০ টাকা, বাকিতে। ঠিক আছে?");
  });

  it("takes টাকায় as money", () => {
    expect([...saidMoney("১২০০ টাকায় কিনলাম")]).toEqual([1200]);
    expect([...saidMoney("1200 takay kinlam")]).toEqual([1200]);
  });
});

describe("a price misheard (D178)", () => {
  it.each([
    [
      "রহিম মোটরসকে একজিও দুই হাজার চৌদ্দ এর সামনের নন জেনুইন ব্রেক প্যাড দুইসেট তিন হাউজার টাকায় বাকিতে দাও",
      3000,
    ],
    ["Rahim Motors ke axio 2014 er brake pad dui set tin haujar takay bakite dao", 3000],
  ] as const)("%s sets %d", (text, amount) => {
    expect(salePriceOf(text)).toEqual({ amount, each: false });
  });

  // The owner's next tries (21 Oct): হাজনার for হাজার, টাকাই for টাকায়, and the answer "হাজার পাঁচশ টাকা".
  it.each([
    [
      "রহিম মোটরসকে একজিও দুই হাজার চৌদ্দ এর সামনের নন জেনুইন ব্রেক প্যাড দুইশে তিন হাজনার টাকায় বাকিতে দাও",
      3000,
    ],
    [
      "রহিম মোটরসকে একজিও দুই হাজার চৌদ্দ এর সামনের নন জেনুইন ব্রেক প্যাড দুইসেট তিন হাউজার টাকাই বাকিতে দাও",
      3000,
    ],
    ["Rahim Motors ke axio 2014 er brake pad dui set tin hajnar takai bakite dao", 3000],
  ] as const)("%s sets %d too", (text, amount) => {
    expect(salePriceOf(text)).toEqual({ amount, each: false });
  });

  it.each([
    ["হাজার পাঁচশ টাকা", 1500],
    ["hajar pachsho taka", 1500],
    ["হাজার টাকা", 1000],
    ["লাখ টাকা", 100000],
    ["দেড় হাজার", 1500],
  ] as const)("“%s” is %d: a thousand said first is one", (text, amount) => {
    expect(parseAmount(text)).toBe(amount);
  });

  it("takes হাউজার for হাজার only after a number", () => {
    expect(parseAmount("তিন হাউজার")).toBe(3000);
    expect(salePriceOf("হাউজার টাকায় দাও")).toBeNull();
  });

  it.each(["দুই সেট ঝাপসা টাকায় দাও", "dui set jhapsa takay dao", "১৫০০ টাকা করে দাও"])(
    "%s says a price",
    (text) => {
      expect(saysSalePrice(text)).toBe(true);
    },
  );

  it.each(["দুই সেট দাও, ২০০০ টাকা নগদ দিল", "dui set bakite dao"])("%s says none", (text) => {
    expect(saysSalePrice(text)).toBe(false);
  });
});

describe("polite sales, tell-me questions and arrivals (D186)", () => {
  it.each([
    ["রহিম মোটরসকে দুইটা প্যাড বাকিতে দেন", "sale"],
    ["Rahim Motors er name e tinta pad nogode likhen", "sale"],
    ["রহিম মোটরসের নামে একটা প্যাড লিখে দেন", "sale"],
    ["রহিম মোটরসের প্যাডের দামটা বলে দেন", null],
    ["Rahim Motors er pad er dam ta bole den", null],
    ["pad gulo dekhan", null],
    ["tejgaon auto care er number ta den", null],
    ["তেজগাঁও অটো কেয়ারের নম্বরটা দেন", null],
    ["রহিম মোটরসের ফোন নম্বর দেন", null],
  ] as const)("%s → %s", (text, kind) => {
    expect(writeCueOf(text, { partyNamed: true })).toBe(kind);
  });

  it.each([
    ["নবাবপুর অটো পার্টস থেকে দশটা প্যাড এলো", "nawabpur"],
    ["Nawabpur Auto Parts theke dui set pad aslo", "nawabpur"],
  ])("%s is a purchase with its supplier named, and nothing without one", (text) => {
    expect(writeCueOf(text, { partyNamed: true, supplierNamed: true })).toBe("stock_in");
    expect(writeCueOf("mal kal asche", { partyNamed: false, supplierNamed: false })).toBeNull();
  });
});
