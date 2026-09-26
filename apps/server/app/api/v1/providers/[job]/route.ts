import { providerSwitchSchema } from "@dokaanbondhu/contracts";
import { aiProviders } from "@dokaanbondhu/platform-db";
import { and, eq, ne } from "drizzle-orm";
import { appError } from "../../../../../src/server/errors";
import { readBody, route } from "../../../../../src/server/route";
import {
  clearProviderCache,
  loadShop,
  providerRows,
  providersInUse,
  settingsOf,
} from "../../../../../src/server/shop";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /providers/{stt|tts} (owner): makes another of the shop's own rows of that job the active one (spec 13.2).
 * Refused for an external provider the owner has not allowed. Applies from the next turn: the cache is cleared.
 */
export const PATCH = route<{ job: string }>({ role: "owner" }, async ({ request, caller, params }) => {
  if (params.job !== "stt" && params.job !== "tts") throw appError("NOT_FOUND", 404, { entity: "job" });
  const job = params.job;
  const { provider_id } = await readBody(request, providerSwitchSchema);
  const settings = await platform().withShop(caller.shopId, async (tx) => {
    const settings = settingsOf(await loadShop(tx, caller.shopId));
    const [target] = await tx
      .select()
      .from(aiProviders)
      .where(
        and(eq(aiProviders.id, provider_id), eq(aiProviders.shopId, caller.shopId), eq(aiProviders.job, job)),
      );
    if (!target || !target.enabled) throw appError("NOT_FOUND", 404, { entity: "provider" });
    if (target.external && !settings.external_providers_allowed) {
      throw appError("EXTERNAL_PROVIDERS_NOT_ALLOWED", 403);
    }
    // one active speech provider per job and shop: switch the others off first
    await tx
      .update(aiProviders)
      .set({ active: false })
      .where(
        and(eq(aiProviders.shopId, caller.shopId), eq(aiProviders.job, job), ne(aiProviders.id, target.id)),
      );
    await tx.update(aiProviders).set({ active: true }).where(eq(aiProviders.id, target.id));
    return settings;
  });
  clearProviderCache(caller.shopId);
  return Response.json({
    in_use: providersInUse(await providerRows(caller.shopId), caller.shopId, settings),
  });
});
