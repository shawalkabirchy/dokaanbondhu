import { capabilityPatchSchema } from "@dokaanbondhu/contracts";
import { CapabilityChangeRefused, capabilityViews, changeCapability } from "@dokaanbondhu/engine/host";
import { z } from "zod";
import { appError } from "../../../../../../src/server/errors";
import { clearHostCache } from "../../../../../../src/server/host";
import { readBody, route } from "../../../../../../src/server/route";
import { platform } from "../../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function capabilityId(value: string): string {
  const id = z.uuid().safeParse(value);
  if (!id.success) throw appError("NOT_FOUND", 404, { entity: "capability" });
  return id.data;
}

/** GET /setup/capabilities/{id} (owner). */
export const GET = route<{ id: string }>({ role: "owner", limit: "setup" }, async ({ caller, params }) => {
  const id = capabilityId(params.id);
  const [capability] = await platform().withShop(caller.shopId, (tx) => capabilityViews(tx, { id }));
  if (!capability) throw appError("NOT_FOUND", 404, { entity: "capability" });
  return Response.json({ capability });
});

/**
 * PATCH /setup/capabilities/{id} (owner): switch on or off, role, template, compensation, read-back, and each
 * parameter's entity, slot, spoken words and confirmation (spec 8.3, 11.8). Switching on needs the sandbox's
 * verified_at (409 CAPABILITY_NOT_VERIFIED, spec 11.11) and every required parameter confirmed.
 */
export const PATCH = route<{ id: string }>(
  { role: "owner", limit: "setup" },
  async ({ request, caller, params }) => {
    const id = capabilityId(params.id);
    const body = await readBody(request, capabilityPatchSchema);
    try {
      const capability = await platform().withShop(caller.shopId, (tx) => changeCapability(tx, id, body));
      if (!capability) throw appError("NOT_FOUND", 404, { entity: "capability" });
      clearHostCache(caller.shopId);
      return Response.json({ capability });
    } catch (error) {
      if (error instanceof CapabilityChangeRefused) {
        throw appError(error.code, error.code === "CAPABILITY_NOT_VERIFIED" ? 409 : 400, error.details);
      }
      throw error;
    }
  },
);
