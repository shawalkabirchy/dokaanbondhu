import { describe, expect, it } from "vitest";
import { connect, fresh, geargrid, ownWords, shopB, tap, type Reply, type Shop } from "../../test/sale-apps";
import type { Step } from "../../test/scripted-llm";

// D195, D199: a part put on a rack by voice or chat, by owner and staff. The rack is read from the user's words (never
// the model's), asked when none was said; the confirmation says the rack from and to, and only the rack is sent, to
// the path that names the part. An app without a rack action keeps it in DokaanBondhu's own list, asked with Yes and
// No and handed to the server, unless the app has its own rack for the part. In Bangla and in Banglish (D96), on the
// three app shapes of D167; the fake apps keep every part on B-3.

/** The buttons that lead each app's request to one part. */
const TO_ONE_PART: Record<string, RegExp[]> = {
  GearGrid: [/ফিল্ডার/, /^2012–2017$/],
  "shop B": [/^Axio$/, /^2012–2017$/, /নন-জেনুইন/],
  "an app with its own words": [/Tucson/i, /Platinum/i],
};
const PART: Record<string, string> = {
  GearGrid: "pad-new",
  "shop B": "2",
  "an app with its own words": "tc-platinum",
};

const RACK = [
  {
    style: "Bangla",
    text: "ব্রেক প্যাডটা সি-২ এ রাখো",
    spelled: "ফিল্ডারের ব্রেক প্যাড সি দুই তাকে রাখো",
    noRack: "ফিল্ডারের ব্রেক প্যাডের র‍্যাক বদলাও",
    answer: "ডি ১৪",
    same: "ফিল্ডারের ব্রেক প্যাড বি-৩ এ রাখো",
    part: "ব্রেক প্যাড",
    fielder: "ফিল্ডার",
    yes: "হ্যাঁ",
    no: "না",
  },
  {
    style: "Banglish",
    text: "brake pad ta C-2 te rakho",
    spelled: "fielder er brake pad c dui take rakho",
    noRack: "fielder er brake pad er rack bodlao",
    answer: "d 14",
    same: "fielder er brake pad B-3 e rakho",
    part: "brake pad",
    fielder: "fielder",
    yes: "ha",
    no: "na",
  },
] as const;

const rackCall = (name: string, part: object): Step[] => [
  { calls: [{ name, arguments: { part: { ...part }, rack: "C-2" } }] },
];

async function tapAll(shop: ReturnType<typeof connect>, reply: Reply, labels: RegExp[]): Promise<Reply> {
  let current = reply;
  for (const label of labels) current = await shop.say(current.state, tap(current, label));
  return current;
}

/** The app with the part of the tests on no rack of its own. */
const withoutRack = (app: Shop): Shop => ({ ...app, racks: { [PART[app.name]!]: [] } });

for (const app of [geargrid, shopB, ownWords]) {
  describe(`${app.name}: a rack change (D195)`, () => {
    it.each(RACK)("asks the part, then confirms the rack from and to, for staff ($style)", async (said) => {
      const shop = connect(app);
      const first = await shop.say(
        fresh(),
        { text: said.text },
        rackCall("update_rack", { part_type: said.part }),
      );
      const reply = await tapAll(shop, first, TO_ONE_PART[app.name]!);
      expect(reply.asked).toBeUndefined();
      expect(reply.confirm?.text).toMatch(/ব্রেক প্যাড রাখা হবে C-2-এ \(এখন B-3\)। ঠিক আছে\?$/);
      expect(reply.confirm?.fields).toEqual(
        expect.arrayContaining([
          { label: "র‍্যাক", value: "C-2", highlight: false },
          { label: "আগে", value: "B-3", highlight: false },
        ]),
      );
      // The app has no dry run for racks: nothing is sent before yes.
      expect(shop.calls).toHaveLength(0);
      expect(reply.state.action?.request).toEqual({
        method: "PATCH",
        path: `/api/v1/parts/${PART[app.name]}/rack`,
        query: {},
        body: { rack_location: "C-2" },
      });
      const done = await shop.say(reply.state, { text: said.yes });
      expect(done.results).toEqual(["done"]);
      expect(shop.calls.at(-1)?.body).toEqual({ rack_location: "C-2" });
    });

    it.each(RACK)(
      "an app without a rack action keeps it in DokaanBondhu's own list, with Yes ($style)",
      async (said) => {
        const shop = connect(withoutRack(app), { noRackAction: true });
        const first = await shop.say(
          fresh(),
          { text: said.text },
          rackCall("keep_rack", { part_type: said.part }),
        );
        const asked = await tapAll(shop, first, TO_ONE_PART[app.name]!);
        expect(asked.reply).toMatch(/ব্রেক প্যাড রাখা হবে C-2-এ। ঠিক আছে\?$/);
        expect(asked.choices?.options.map((option) => option.label)).toEqual(["হ্যাঁ", "না"]);
        expect(asked.confirm).toBeUndefined();
        const kept = await shop.say(asked.state, { text: said.yes });
        expect(kept.reply).toMatch(/^রাখা হলো: .*ব্রেক প্যাড এখন C-2-এ।$/);
        expect(kept.racks).toEqual([{ hostPartId: PART[app.name], rack: "C-2" }]);
        expect(shop.calls).toHaveLength(0);
      },
    );

    it.each(RACK)("No keeps nothing in the own list ($style)", async (said) => {
      const shop = connect(withoutRack(app), { noRackAction: true });
      const first = await shop.say(
        fresh(),
        { text: said.text },
        rackCall("keep_rack", { part_type: said.part }),
      );
      const asked = await tapAll(shop, first, TO_ONE_PART[app.name]!);
      const no = await shop.say(asked.state, { text: said.no });
      expect(no.reply).toBe("বাতিল করা হয়েছে, কিছু সেভ হয়নি।");
      expect(no.racks).toEqual([]);
    });
  });
}

describe("what is said, and what is asked (GearGrid, D195)", () => {
  const fielder = (said: (typeof RACK)[number]) => ({ part_type: said.part, vehicle: said.fielder });

  it.each(RACK)("a rack said sign by sign is read as the label ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.spelled }, rackCall("update_rack", fielder(said)));
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.state.action?.request.body).toEqual({ rack_location: "C-2" });
  });

  it.each(RACK)(
    "no rack said: asks which, and a rack the model made up is not taken ($style)",
    async (said) => {
      const shop = connect(geargrid);
      const first = await shop.say(fresh(), { text: said.noRack }, rackCall("update_rack", fielder(said)));
      const asked = await shop.say(first.state, tap(first, /^2012–2017$/));
      expect(asked.reply).toMatch(/কোন র‍্যাকে রাখব\?$/);
      const reply = await shop.say(asked.state, { text: said.answer });
      expect(reply.confirm?.text).toMatch(/রাখা হবে D-14-এ \(এখন B-3\)। ঠিক আছে\?$/);
    },
  );

  it.each(RACK)("the rack the part is on already is said, and nothing is asked ($style)", async (said) => {
    const shop = connect(geargrid);
    const first = await shop.say(fresh(), { text: said.same }, rackCall("update_rack", fielder(said)));
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.reply).toMatch(/এখনই B-3-এ আছে।$/);
    expect(reply.confirm).toBeUndefined();
  });

  it.each(RACK)("started from the words when the model searches instead ($style)", async (said) => {
    const shop = connect(geargrid, { role: "owner" });
    const search: Step[] = [{ calls: [{ name: "find_parts", arguments: fielder(said) }] }];
    const first = await shop.say(fresh(), { text: said.spelled }, search);
    const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
    expect(reply.confirm?.text).toMatch(/রাখা হবে C-2-এ \(এখন B-3\)। ঠিক আছে\?$/);
  });

  it.each(RACK)(
    "an app without a rack action: a rack the app records is changed in the app ($style)",
    async (said) => {
      const shop = connect(geargrid, { noRackAction: true });
      const first = await shop.say(fresh(), { text: said.spelled }, rackCall("keep_rack", fielder(said)));
      const reply = await shop.say(first.state, tap(first, /^2012–2017$/));
      expect(reply.reply).toMatch(/র‍্যাক অ্যাপে লেখা আছে: B-3। বদলাতে অ্যাপেই বদলান।$/);
      expect(reply.racks).toEqual([]);
    },
  );

  it.each(RACK)(
    "the own list's rack is said as the one now, and typed yes keeps the new one ($style)",
    async (said) => {
      const shop = connect(withoutRack(geargrid), {
        noRackAction: true,
        ownRacks: new Map([["pad-new", "A-1"]]),
      });
      const first = await shop.say(fresh(), { text: said.spelled }, rackCall("keep_rack", fielder(said)));
      const asked = await shop.say(first.state, tap(first, /^2012–2017$/));
      expect(asked.reply).toMatch(/রাখা হবে C-2-এ \(এখন A-1\)। ঠিক আছে\?$/);
      const kept = await shop.say(asked.state, tap(asked, /^হ্যাঁ$/));
      expect(kept.racks).toEqual([{ hostPartId: "pad-new", rack: "C-2" }]);
    },
  );
});
