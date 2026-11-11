import { describe, expect, it } from "vitest";
import { connect, fresh, geargrid, ownWords, shopB, tap, type Reply, type Shop } from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// The first voice run of the test set (D237): part numbers said aloud sign by sign as speech-to-text writes them,
// misheard and glued; a rack said as one word; a phone asked of a named customer or supplier. On the three app shapes
// of D167, in Bangla and in Banglish (D96), with the model's own calls from the run where it went wrong.

const call = (name: string, args: object): Step[] => [{ calls: [{ name, arguments: { ...args } }] }];

/** Each app with two of its pads under real part numbers, one sound apart at the end ("…১০০১০", "…১০০৪৭"). */
const numbered = (app: Shop, first: string, second: string): Shop => ({
  ...app,
  parts: app.parts.map((part) =>
    part.id === first
      ? { ...part, numbers: ["04465-10010"] }
      : part.id === second
        ? { ...part, numbers: ["04465-10047"] }
        : part,
  ),
});
const APPS = [
  numbered(geargrid, "pad-new", "pad-old"),
  numbered(shopB, "1", "2"),
  numbered(ownWords, "tc-platinum", "tc-silver-rexo"),
];

/** 04465-10010 said as the speakers said part numbers, then as speech-to-text misheard them in the run. */
const SAID = [
  {
    style: "Bangla",
    clean: "জিরো ফোর ফোর সিক্স ফাইভ ওয়ান জিরো জিরো ওয়ান জিরো",
    misheard: "জিরো ফোর ফোট সিক্স ফাইভ ওয়ান জিলো জিরো ওয়াইন জিরো",
    price: "নম্বরের প্যাডের দাম কত",
    newPrice: "পার্টের খুচরা দাম ১৭০০ টাকা করো",
    yes: "হ্যাঁ",
  },
  {
    style: "Banglish",
    clean: "zero four four six five one zero zero one zero",
    misheard: "zero four fot six five one jilo zero wine zero",
    price: "number er pad er dam koto",
    newPrice: "part er khuchra dam 1700 taka koro",
    yes: "ha",
  },
] as const;

for (const app of APPS) {
  describe(`${app.name}: a part number said aloud (D237)`, () => {
    it.each(SAID)(
      "is the part search, misheard or not, and the model's guessed car is dropped ($style)",
      async (said) => {
        for (const digits of [said.clean, said.misheard]) {
          const shop = connect(app, { evalMode: true });
          const text = `${digits} ${said.price}`;
          // The model's own call in the run: a number it made up and a car it read into "প্রাইস" (v-054, v-058).
          const answer = await shop.say(fresh(), { text }, [
            ...call("find_parts", { part_number: "30101", vehicle: "Toyota Prius" }),
            { text: "" },
          ]);
          expect(answer.asked, `${text}: ${answer.reply}`).toBeUndefined();
          expect(answer.found).toContain("04465-10010");
          expect(answer.found).not.toContain("04465-10047");
          expect(answer.reply).not.toMatch(/প্রিয়াস|Prius/);
        }
      },
    );

    it.each(SAID)("changes the price of the part it names, for the owner ($style)", async (said) => {
      const shop = connect(app, { role: "owner" });
      const text = `${said.misheard} ${said.newPrice}`;
      // The model's call in the run (v-114): a piece of the number and a part type it made up.
      const sheet = await shop.say(
        fresh(),
        { text },
        call("update_price", {
          part: { part_number: "0199", part_type: "Brake Pad (0.90)" },
          prices: { retail: "1700" },
        }),
      );
      expect(sheet.asked, `${text}: ${sheet.reply}`).toBeUndefined();
      expect(sheet.confirm?.text).toMatch(/থেকে ১,৭০০ টাকা/);
      const part = app.parts.find((candidate) => candidate.numbers?.includes("04465-10010"))!;
      expect(sheet.state.action?.request.path).toContain(`/parts/${part.id}`);
    });

    it.each(SAID)("is the answer to “which part number?”, said aloud ($style)", async (said) => {
      const shop = connect(app);
      const first = await shop.say(
        fresh(),
        { text: "XYZ-9 নম্বরের প্যাড আছে?" },
        call("find_parts", { part_number: "XYZ-9" }),
      );
      expect(first.asked).toBe("part_number");
      const answer = await shop.say(first.state, { text: said.misheard });
      expect(answer.asked).toBeUndefined();
      expect(answer.found).toContain("04465-10010");
    });
  });
}

describe("ordinary words before a cue are no part number (D237)", () => {
  it.each([
    { style: "Bangla", text: "এক্সিও ২০১৪ সামনের ব্রেক প্যাডের পার্ট নম্বর কত" },
    { style: "Banglish", text: "axio 2014 samner brake pad er part number koto" },
  ])("the model's search goes on as it was ($style)", async ({ text }) => {
    const [app] = APPS;
    const shop = connect(app!, { evalMode: true });
    const answer = await shop.say(fresh(), { text }, [
      ...call("find_parts", { part_type: "brake pad", vehicle: "axio", year: "2014" }),
      { text: "" },
    ]);
    // A search by the part's type, as the model asked; a number's search would have resolved no type.
    expect(answer.trace.lookups.at(-1)?.resolved.part_type).toBe("Brake Pad");
  });
});

describe("a phone asked of a named customer or supplier (D237)", () => {
  const PHONES = [
    {
      style: "Bangla",
      customer: "রহিম মোটরসের ফোন নম্বর কি",
      // As speech-to-text wrote Nawabpur Auto Parts Ltd. in the run (v-109).
      supplier: "নবাবপুর অটো পয়েন্টের ফোন নাম্বারটা কি",
      bare: "রহিম মোটরসের নাম্বারটা দেন",
    },
    {
      style: "Banglish",
      customer: "rahim motors er phone number ki",
      supplier: "nawabpur auto point er phone number ta ki",
      bare: "rahim motors er number ta den",
    },
  ] as const;

  for (const app of [geargrid, shopB, ownWords]) {
    it.each(PHONES)(`is said from the shop's list, without the LLM (${app.name}, $style)`, async (said) => {
      const shop = connect(app);
      for (const text of [said.customer, said.bare]) {
        const answer = await shop.say(fresh(), { text });
        expect(answer.reply, text).toBe("Rahim Motors-এর ফোন নম্বর ০১৭১১-০০০০০০।");
        expect(answer.trace.llm_calls).toBe(0);
      }
      const supplier = await shop.say(fresh(), { text: said.supplier });
      expect(supplier.reply).toBe("Nawabpur Auto Parts-এর ফোন নম্বর ০১৯১১-০০০০০০।");
    });
  }

  it.each(PHONES)("a phone the app does not keep is said so ($style)", async (said) => {
    const shop = connect({ ...geargrid, customerAttrs: { phone: "" } });
    const answer = await shop.say(fresh(), { text: said.customer });
    expect(answer.reply).toBe("Rahim Motors-এর ফোন নম্বর অ্যাপে নেই।");
  });
});

/** The buttons that lead each app's request to one part (as in racks.test.ts). */
const TO_ONE_PART: Record<string, RegExp[]> = {
  GearGrid: [/ফিল্ডার/, /^2012–2017$/],
  "shop B": [/^Axio$/, /^2012–2017$/, /নন-জেনুইন/],
  "an app with its own words": [/Tucson/i, /Platinum/i],
};

async function tapAll(shop: ReturnType<typeof connect>, reply: Reply, labels: RegExp[]): Promise<Reply> {
  let current = reply;
  for (const label of labels) current = await shop.say(current.state, tap(current, label));
  return current;
}

describe("a rack said as one word (D237)", () => {
  // As speech-to-text wrote C-1 in the run (v-203), and the model passed it on as said.
  const GLUED = [
    { style: "Bangla", text: "ব্রেক প্যাডটা সিওয়ান রেখে রাখো", part: "ব্রেক প্যাড", rack: "সিওয়ান" },
    { style: "Banglish", text: "brake pad ta c1 e rekhe rakho", part: "brake pad", rack: "c1" },
  ] as const;
  for (const app of [geargrid, shopB, ownWords]) {
    it.each(GLUED)(`is read as its label (${app.name}, $style)`, async (said) => {
      const shop = connect(app);
      const first = await shop.say(fresh(), { text: said.text }, [
        { calls: [{ name: "update_rack", arguments: { part: { part_type: said.part }, rack: said.rack } }] },
      ]);
      const reply = await tapAll(shop, first, TO_ONE_PART[app.name]!);
      expect(reply.asked, reply.reply).toBeUndefined();
      expect(reply.confirm?.text).toMatch(/ব্রেক প্যাড রাখা হবে C-1-এ \(এখন B-3\)। ঠিক আছে\?$/);
    });
  }
});

// Found by CI on the first push (D237): "জেনুইন" split as J and "নুইন", a letter from নাইন, and counted as rack J-9, so
// a sale lost its quality. A glued rack now takes only an exact English digit word.
describe("a quality is never a rack said as one word (D237)", () => {
  it.each([
    { style: "Bangla", text: "রহিম মোটরসকে এক্সিও ২০০৮ সামনের জেনুইন ব্রেক প্যাড এক সেট নগদে দাও" },
    { style: "Banglish", text: "Rahim Motors ke axio 2008 samner genuine brake pad ek set nogode dao" },
  ])("a sale keeps its quality, heard in the words ($style)", async ({ text }) => {
    const shop = connect(geargrid);
    const sheet = await shop.say(fresh(), { text }, [
      {
        calls: [
          {
            name: "record_sale",
            arguments: {
              customer: "Rahim Motors",
              items: [
                {
                  part: {
                    part_type: "brake pad",
                    vehicle: "axio",
                    year: "2008",
                    position: "front",
                    // in English, as the model wrote it for a Bangla request: kept only when the words say it
                    quality: "genuine",
                  },
                },
              ],
              payment: { method_word: text.includes("নগদে") ? "নগদে" : "nogode" },
            },
          },
        ],
      },
    ]);
    expect(sheet.confirm?.text, sheet.reply).toMatch(
      /^Rahim Motors — এক্সিও ২০০৮, সামনের ব্রেক প্যাড, জেনুইন, ১ সেট/,
    );
  });
});
