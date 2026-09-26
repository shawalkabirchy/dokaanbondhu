import type { Me } from "@dokaanbondhu/contracts";
import { users } from "@dokaanbondhu/platform-db";
import { eq } from "drizzle-orm";
import { appError } from "../../../../src/server/errors";
import { route } from "../../../../src/server/route";
import { loadShop, providerRows, providersInUse, settingsOf, userView } from "../../../../src/server/shop";
import { platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /me (spec 8.3): the user, role, shop, shop settings and the providers in use. */
export const GET = route({ role: "any" }, async ({ caller }) => {
  const { user, shop } = await platform().withShop(caller.shopId, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, caller.userId));
    return { user, shop: await loadShop(tx, caller.shopId) };
  });
  if (!user) throw appError("NOT_FOUND", 404, { entity: "user" });
  const settings = settingsOf(shop);
  const body: Me = {
    user: userView(user),
    shop: { id: shop.id, name: shop.name, market_area: shop.marketArea },
    settings,
    providers: providersInUse(await providerRows(caller.shopId), caller.shopId, settings),
  };
  return Response.json(body);
});
