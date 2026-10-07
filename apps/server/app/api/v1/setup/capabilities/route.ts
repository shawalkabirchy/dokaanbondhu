import { capabilityViews } from "@dokaanbondhu/engine/host";
import { z } from "zod";
import { appError } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/route";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /setup/capabilities?connection_id= (owner): the capabilities with their parameters; all of the shop's without. */
export const GET = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const raw = new URL(request.url).searchParams.get("connection_id");
  const id = raw === null ? null : z.uuid().safeParse(raw);
  if (id && !id.success) throw appError("VALIDATION_FAILED", 400, { field: "connection_id" });
  const capabilities = await platform().withShop(caller.shopId, (tx) =>
    capabilityViews(tx, id ? { connectionId: id.data } : {}),
  );
  return Response.json({ capabilities });
});
