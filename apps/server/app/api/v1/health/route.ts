import type { Health } from "@dokaanbondhu/contracts";
import { recentHealth, speechHealth } from "@dokaanbondhu/engine/providers";
import { sql } from "drizzle-orm";
import packageJson from "../../../../package.json";
import { platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /health (spec 8.8, D55): status from the server and the platform DB only; speech and LLM never woken. */
export async function GET(): Promise<Response> {
  let db: Health["db"] = "down";
  try {
    await Promise.race([
      platform().withAdmin((tx) => tx.execute(sql`select 1`)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    db = "ok";
  } catch {
    // the platform DB did not answer: status is down
  }
  const body: Health = {
    status: db,
    version: packageJson.version,
    db,
    speech: speechHealth(),
    llm: recentHealth("llm"),
  };
  return Response.json(body);
}
