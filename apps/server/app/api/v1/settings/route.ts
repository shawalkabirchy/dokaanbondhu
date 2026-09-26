import { settingsPatchSchema } from "@dokaanbondhu/contracts";
import { shops } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { readBody, route } from "../../../../src/server/route";
import { clearProviderCache, loadShop, settingsOf } from "../../../../src/server/shop";
import { platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /settings (any): the shop's settings with every default filled in. */
export const GET = route({ role: "any" }, async ({ caller }) => {
  const shop = await platform().withShop(caller.shopId, (tx) => loadShop(tx, caller.shopId));
  return Response.json({ settings: settingsOf(shop) });
});

/** PATCH /settings (owner): voice, external providers and the staff price override (spec 8.3). */
export const PATCH = route({ role: "owner" }, async ({ request, caller }) => {
  const patch = await readBody(request, settingsPatchSchema);
  const shop = await platform().withShop(caller.shopId, async (tx) => {
    const current = await loadShop(tx, caller.shopId);
    const [updated] = await tx
      .update(shops)
      .set({ settings: { ...current.settings, ...patch } })
      .where(eq(shops.id, caller.shopId))
      .returning();
    return updated ?? current;
  });
  clearProviderCache(caller.shopId); // external providers may have been switched on or off
  return Response.json({ settings: settingsOf(shop) });
});
