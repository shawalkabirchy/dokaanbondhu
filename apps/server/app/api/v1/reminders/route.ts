import { REMINDER_NAMES, type Reminders } from "@dokaanbondhu/contracts";
import { lowStock, oldDues, REMINDER_ROWS } from "@dokaanbondhu/engine/host";
import { shopHost } from "../../../../src/server/host";
import { route } from "../../../../src/server/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /reminders (any): parts running low and customers' old dues, counted, with the first few names, for the
 * assistant page's card (spec 8.3, D194). Read from the shop's app as the assistant reads them; a kind the app cannot
 * give is null, and a shop with no app connected has neither.
 */
export const GET = route({ role: "any" }, async ({ caller }) => {
  const { host } = await shopHost(caller.shopId);
  if (!host.map || !host.run) return Response.json({ low_stock: null, old_dues: null } satisfies Reminders);
  const read = { map: host.map, run: host.run };
  const now = new Date();
  const [low, old] = await Promise.all([lowStock(read, host.catalog, now), oldDues(read, host.catalog, now)]);
  const names = (lines: { name: string; nameBn: string | null }[]) =>
    lines.slice(0, REMINDER_NAMES).map((line) => line.nameBn ?? line.name);
  const body: Reminders = {
    low_stock: low && { count: low.length, more: low.length >= REMINDER_ROWS, names: names(low) },
    old_dues: old && {
      count: old.length,
      more: old.length >= REMINDER_ROWS,
      names: names(old),
      old_taka: Number(old.reduce((sum, line) => sum + line.old, 0n)),
    },
  };
  return Response.json(body);
});
