import { route } from "../../../../../src/server/route";
import { wordsView } from "../../../../../src/server/words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /setup/words (owner): words the assistant learned, to add or dismiss, and the listening check's count (D102). */
export const GET = route({ role: "owner", limit: "setup" }, async ({ caller }) =>
  Response.json({ words: await wordsView(caller.shopId) }),
);
