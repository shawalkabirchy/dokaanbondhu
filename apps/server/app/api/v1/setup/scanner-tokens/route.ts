import type { ScannerTokenResult } from "@dokaanbondhu/contracts";
import { newSetupToken, SETUP_TOKEN_MS, setupTokenHash, setupTokens } from "@dokaanbondhu/platform-db";
import { route } from "../../../../../src/server/route";
import { platform } from "../../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /setup/scanner-tokens (owner): a one-time token for the Laravel scanner's upload, valid 15 minutes (spec 8.3,
 * 16.3). Only its hash is stored; the token is shown once, for the owner to give the scanner.
 */
export const POST = route({ role: "owner", limit: "setup" }, async ({ caller }) => {
  const token = newSetupToken();
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_MS);
  await platform().withShop(caller.shopId, (tx) =>
    tx.insert(setupTokens).values({
      shopId: caller.shopId,
      tokenHash: setupTokenHash(token),
      purpose: "scanner_upload",
      expiresAt,
      createdBy: caller.userId,
    }),
  );
  const result: ScannerTokenResult = { token, expires_at: expiresAt.toISOString() };
  return Response.json(result, { status: 201 });
});
