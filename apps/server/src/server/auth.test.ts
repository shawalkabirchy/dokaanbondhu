import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@dokaanbondhu/core";
import { bearerToken, verifyAccessToken } from "./auth";

const SUPABASE_URL = "http://localhost:54321";
const SECRET = "test-secret-at-least-16-chars";

function token(fields: { sub?: string; iss?: string; aud?: string; exp?: number }, secret = SECRET) {
  const jwt = new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
  if (fields.sub) jwt.setSubject(fields.sub);
  jwt.setIssuer(fields.iss ?? `${SUPABASE_URL}/auth/v1`);
  jwt.setAudience(fields.aud ?? "authenticated");
  jwt.setExpirationTime(fields.exp ?? Math.floor(Date.now() / 1000) + 600);
  return jwt.sign(new TextEncoder().encode(secret));
}

beforeAll(() => {
  Object.assign(process.env, {
    PLATFORM_DATABASE_URL: "postgres://unused@localhost/unused",
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: "sb_secret_unused_in_this_test",
    AES_KEY: randomBytes(32).toString("base64"),
    JWT_TEST_SECRET: SECRET,
  });
});

describe("access tokens", () => {
  it("accepts a valid token and returns its subject", async () => {
    expect(await verifyAccessToken(await token({ sub: "auth-user-1" }))).toBe("auth-user-1");
  });

  it("refuses a wrong signature, issuer, audience, an expired token and a token without a subject", async () => {
    const bad = [
      await token({ sub: "u" }, "another-secret-of-16+"),
      await token({ sub: "u", iss: "https://evil.example/auth/v1" }),
      await token({ sub: "u", aud: "anon" }),
      await token({ sub: "u", exp: Math.floor(Date.now() / 1000) - 60 }),
      await token({}),
      "not-a-jwt",
    ];
    for (const value of bad) {
      await expect(verifyAccessToken(value)).rejects.toMatchObject({
        code: "UNAUTHENTICATED",
        httpStatus: 401,
      });
    }
  });

  it("reads only a Bearer header", () => {
    const request = (value?: string) =>
      new Request("http://x/api/v1/me", value ? { headers: { authorization: value } } : undefined);
    expect(bearerToken(request("Bearer abc.def.ghi"))).toBe("abc.def.ghi");
    expect(() => bearerToken(request())).toThrow(AppError);
    expect(() => bearerToken(request("Basic abc"))).toThrow(AppError);
  });
});
