import { staffPatchSchema } from "@dokaanbondhu/contracts";
import { users } from "@dokaanbondhu/platform-db";
import { eq, sql } from "drizzle-orm";
import { appError } from "../../../../../src/server/errors";
import { forgetUser, readBody, route } from "../../../../../src/server/route";
import { userView } from "../../../../../src/server/shop";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /staff/{userId} (owner): turn a staff login off or on again. The owner's own login cannot be changed. */
export const PATCH = route<{ userId: string }>({ role: "owner" }, async ({ request, caller, params }) => {
  const body = await readBody(request, staffPatchSchema);
  if (!/^[0-9a-f-]{36}$/i.test(params.userId)) throw appError("NOT_FOUND", 404, { entity: "user" });
  const row = await platform().withShop(caller.shopId, async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, params.userId));
    if (!target) throw appError("NOT_FOUND", 404, { entity: "user" });
    if (target.role === "owner") throw appError("FORBIDDEN", 403, { reason: "the owner's login" });
    const [updated] = await tx
      .update(users)
      .set({ status: body.status, updatedAt: sql`now()` })
      .where(eq(users.id, target.id))
      .returning();
    return updated;
  });
  if (!row) throw appError("NOT_FOUND", 404, { entity: "user" });
  forgetUser(row.authUserId); // a disabled login is refused on its next request
  return Response.json({ staff: userView(row) });
});
