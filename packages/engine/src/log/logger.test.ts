import { describe, expect, it } from "vitest";
import { redactSecrets } from "./logger";

describe("log redaction", () => {
  it("hides values under authorization, secret, password and key names at any depth", () => {
    expect(
      redactSecrets({
        headers: { authorization: "Bearer abc", "x-api-key": "k1" },
        provider: { secret_encrypted: "v1:xyz", apiKey: "sk-1", model: "gemma" },
        user: { password: "hunter22", name: "Rafiq" },
        list: [{ token_secret: "s" }],
      }),
    ).toEqual({
      headers: { authorization: "[redacted]", "x-api-key": "[redacted]" },
      provider: { secret_encrypted: "[redacted]", apiKey: "[redacted]", model: "gemma" },
      user: { password: "[redacted]", name: "Rafiq" },
      list: [{ token_secret: "[redacted]" }],
    });
  });

  it("masks the password inside a connection string, in plain text and in errors", () => {
    const url =
      "postgresql://platform_api.abc:p4ss@aws-0.pooler.supabase.com:5432/postgres?sslmode=verify-full";
    expect(redactSecrets({ msg: `cannot connect to ${url}` })).toEqual({
      msg: "cannot connect to postgresql://platform_api.abc:***@aws-0.pooler.supabase.com:5432/postgres?sslmode=verify-full",
    });
    const logged = redactSecrets({ err: new Error(`failed: ${url}`) }) as { err: { message: string } };
    expect(logged.err.message).not.toContain("p4ss");
  });
});
