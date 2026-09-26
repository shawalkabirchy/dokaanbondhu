import { staffCreateSchema } from "@dokaanbondhu/contracts";
import { users } from "@dokaanbondhu/platform-db";
import { asc, desc } from "drizzle-orm";
import { authAdmin } from "../../../../src/server/auth-admin";
import { readBody, route } from "../../../../src/server/route";
import { userView } from "../../../../src/server/shop";
import { logger, platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /staff (owner): the shop's logins, the owner first. */
export const GET = route({ role: "owner" }, async ({ caller }) => {
  const rows = await platform().withShop(caller.shopId, (tx) =>
    tx.select().from(users).orderBy(desc(users.role), asc(users.name)),
  );
  return Response.json({ staff: rows.map(userView) });
});

/** POST /staff (owner): a new staff login through the Supabase admin API, with email_confirm (spec 8.3, D9, D42). */
export const POST = route({ role: "owner" }, async ({ request, caller }) => {
  const body = await readBody(request, staffCreateSchema);
  const authUser = await authAdmin().createUser({
    email: body.email,
    password: body.password,
    name: body.name,
  });
  try {
    const [row] = await platform().withShop(caller.shopId, (tx) =>
      tx
        .insert(users)
        .values({
          shopId: caller.shopId,
          authUserId: authUser.id,
          name: body.name,
          email: body.email,
          phone: body.phone ?? null,
          role: "staff",
        })
        .returning(),
    );
    if (!row) throw new Error("the staff row was not written");
    return Response.json({ staff: userView(row) }, { status: 201 });
  } catch (error) {
    // no half-made login: remove the Supabase user again
    await authAdmin()
      .deleteUser(authUser.id)
      .catch((cleanup: unknown) => logger().error({ err: cleanup }, "could not remove the auth user"));
    throw error;
  }
});
