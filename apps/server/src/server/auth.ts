import { createRemoteJWKSet, jwtVerify } from "jose";
import { serverEnv } from "../env";
import { appError } from "./errors";

// Who is calling (spec 8.2): a Supabase access token, verified with jose against the project's JWKS (issuer
// <SUPABASE_URL>/auth/v1, audience "authenticated", expiry checked). In CI: HS256 tokens signed with JWT_TEST_SECRET.

const holder = globalThis as { __dokaanJwks?: ReturnType<typeof createRemoteJWKSet> };

const issuerOf = (supabaseUrl: string) => `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;

/** Returns the Supabase Auth user ID (the token's subject), or throws UNAUTHENTICATED. */
export async function verifyAccessToken(token: string): Promise<string> {
  const env = serverEnv();
  const issuer = issuerOf(env.SUPABASE_URL);
  try {
    const { payload } = env.JWT_TEST_SECRET
      ? await jwtVerify(token, new TextEncoder().encode(env.JWT_TEST_SECRET), {
          issuer,
          audience: "authenticated",
          algorithms: ["HS256"],
        })
      : await jwtVerify(
          token,
          (holder.__dokaanJwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))),
          { issuer, audience: "authenticated", algorithms: ["ES256", "RS256"] },
        );
    if (!payload.sub) throw new Error("no subject");
    return payload.sub;
  } catch {
    throw appError("UNAUTHENTICATED", 401);
  }
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) throw appError("UNAUTHENTICATED", 401);
  return match[1];
}
