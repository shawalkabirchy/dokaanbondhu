import { z } from "zod";
import { appError } from "../../../../../src/server/errors";
import { route } from "../../../../../src/server/route";
import { schemaView } from "../../../../../src/server/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /setup/schema?connection_id= (owner): the schema map with sample values as they will be spoken (spec 11.3). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ request, caller }) => {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("connection_id"));
  if (!id.success) throw appError("VALIDATION_FAILED", 400, { field: "connection_id" });
  return Response.json({ schema: await schemaView(caller.shopId, id.data) });
});
