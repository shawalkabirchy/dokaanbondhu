import type { ProviderView } from "@dokaanbondhu/contracts";
import { candidatesFor, type ProviderJob } from "@dokaanbondhu/engine/providers";
import { route } from "../../../../src/server/route";
import {
  loadShop,
  providerRows,
  providersInUse,
  providerView,
  settingsOf,
} from "../../../../src/server/shop";
import { platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /providers (owner): the speech and LLM providers that apply to the shop. External ones are listed too (marked),
 * so the owner sees what switching them on would add; `in_use` is what answers now.
 */
export const GET = route({ role: "owner" }, async ({ caller }) => {
  const shop = await platform().withShop(caller.shopId, (tx) => loadShop(tx, caller.shopId));
  const settings = settingsOf(shop);
  const rows = await providerRows(caller.shopId);
  const jobs: ProviderJob[] = ["llm", "stt", "tts"];
  const providers: ProviderView[] = jobs.flatMap((job) =>
    candidatesFor(rows, caller.shopId, job, true).map(providerView),
  );
  return Response.json({
    external_providers_allowed: settings.external_providers_allowed,
    providers,
    in_use: providersInUse(rows, caller.shopId, settings),
  });
});
