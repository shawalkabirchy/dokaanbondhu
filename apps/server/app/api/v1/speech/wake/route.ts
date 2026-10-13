import type { SpeechWake } from "@dokaanbondhu/contracts";
import { route } from "../../../../../src/server/route";
import { wakeShopSpeech } from "../../../../../src/server/shop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /speech/wake (spec 8.3, D164): starts the shop's speech worker waking in the background and answers the speech
 * state within 2 s. Signed-in users only, so no stranger can start the GPU; /health itself still wakes nothing (D55).
 */
export const POST = route({ role: "any" }, async ({ caller }) => {
  const body: SpeechWake = { speech: await wakeShopSpeech(caller.shopId) };
  return Response.json(body);
});
