import { describe, expect, it } from "vitest";
import {
  answered,
  connect,
  fresh,
  SALE,
  saleCall,
  SHOPS,
  tap,
  type Api,
  type ApiAnswer,
  type Reply,
} from "../../test/sale-apps";
import { HostCallFailed, HOST_TIMEOUT_MS, WAKE_WAIT_MS } from "../host/api";

// D168: a shop app asleep, as a free host is after 15 quiet minutes, is waited for. The owner's credit sale of 16 Oct
// said "কাজ হয়নি। অ্যাপ সাড়া দেয়নি।" at the last tap, because the dry run was the sale's first call to the app and
// it woke in about a minute. Now the app is woken when the sale starts, and a dry run it does not answer in time is
// sent once more and waited for. The sale in Bangla and in Banglish (D96), on the three app shapes of D167.

/** The buttons that lead each app's sale to one part, and so to its dry run. */
const TO_ONE_PART: Record<string, RegExp[]> = {
  GearGrid: [/ফিল্ডার/, /^2012–2017$/],
  "shop B": [/^Axio$/, /^2012–2017$/, /নন-জেনুইন/],
  "an app with its own words": [/Tucson/i, /Platinum/i],
};

async function toSheet(shop: ReturnType<typeof connect>, app: string, reply: Reply): Promise<Reply> {
  let current = reply;
  for (const label of TO_ONE_PART[app]!) current = await shop.say(current.state, tap(current, label));
  expect(current.asked).toBeUndefined();
  return current;
}

/** An app whose first `times` calls fail with `reason`, and which then answers; each call's wait is kept. */
function failing(reason: HostCallFailed["reason"], times: number, waits: (number | undefined)[]): ApiAnswer {
  let failed = 0;
  return async (request, options) => {
    waits.push(options?.timeoutMs);
    if (failed < times) {
      failed += 1;
      throw new HostCallFailed(
        reason === "timeout" ? "the host did not answer in time" : "unreachable",
        reason,
      );
    }
    return answered(request, options);
  };
}

async function sell(app: (typeof SHOPS)[number], sale: (typeof SALE)[number], api: Api = {}) {
  const shop = connect(app, api);
  const first = await shop.say(fresh(), { text: sale.text }, saleCall(sale.args));
  const woken = shop.wakes.count;
  const callsBefore = shop.calls.length;
  return { shop, first, woken, callsBefore, last: await toSheet(shop, app.name, first) };
}

for (const app of SHOPS) {
  describe(`${app.name}: the sale's app asleep (D168)`, () => {
    it.each(SALE)("is woken when the sale starts, before any question is answered ($style)", async (sale) => {
      const { shop, first, woken, callsBefore, last } = await sell(app, sale);
      expect(first.asked).toBeDefined();
      expect(woken).toBeGreaterThan(0);
      expect(callsBefore).toBe(0);
      expect(last.confirm?.text).toMatch(/ঠিক আছে\?$/);
      expect(shop.calls).toHaveLength(1);
      expect(last.statuses).not.toContain("status.starting");
    });

    it.each(SALE)(
      "a dry run not answered in time is sent once more, waited for, and the sheet comes ($style)",
      async (sale) => {
        const waits: (number | undefined)[] = [];
        const { shop, last } = await sell(app, sale, { answer: failing("timeout", 1, waits) });
        expect(last.statuses).toContain("status.starting");
        expect(last.confirm?.text).toMatch(/ঠিক আছে\?$/);
        expect(shop.calls).toHaveLength(2);
        expect(shop.calls[1]).toEqual(shop.calls[0]);
        expect(waits).toEqual([undefined, WAKE_WAIT_MS]);
        expect(WAKE_WAIT_MS).toBeGreaterThan(HOST_TIMEOUT_MS);
      },
    );

    it.each(SALE)("an app that stays asleep: said once, after the longer wait ($style)", async (sale) => {
      const waits: (number | undefined)[] = [];
      const { shop, last } = await sell(app, sale, { answer: failing("timeout", 2, waits) });
      expect(last.confirm).toBeUndefined();
      expect(last.reply).toContain("অ্যাপ সাড়া দেয়নি।");
      expect(shop.calls).toHaveLength(2);
    });

    it.each(SALE)("an app that cannot be reached is said at once, not sent again ($style)", async (sale) => {
      const waits: (number | undefined)[] = [];
      const { shop, last } = await sell(app, sale, { answer: failing("network", 1, waits) });
      expect(last.confirm).toBeUndefined();
      expect(last.reply).toContain("অ্যাপ সাড়া দেয়নি।");
      expect(last.statuses).not.toContain("status.starting");
      expect(shop.calls).toHaveLength(1);
    });

    it.each(SALE)(
      "an app without a dry run is woken too, and its sheet needs no call ($style)",
      async (sale) => {
        const { shop, woken, last } = await sell(app, sale, { dryRun: false });
        expect(woken).toBeGreaterThan(0);
        expect(last.confirm?.text).toMatch(/ঠিক আছে\?$/);
        expect(shop.calls).toHaveLength(0);
      },
    );
  });
}
