import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@dokaanbondhu/core";
import { decryptSecret, encryptSecret, parseAesKey } from "./secrets";

const key = randomBytes(32);
const place = { table: "connections", rowId: randomUUID(), column: "secret_encrypted" };

describe("stored secrets", () => {
  it("round-trips and never stores the plain text", () => {
    const stored = encryptSecret(key, place, "db-password-123");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("db-password-123");
    expect(decryptSecret(key, place, stored)).toBe("db-password-123");
  });

  it("uses a new IV every time", () => {
    expect(encryptSecret(key, place, "same")).not.toBe(encryptSecret(key, place, "same"));
  });

  it("refuses a ciphertext copied to another row or column", () => {
    const stored = encryptSecret(key, place, "secret");
    expect(() => decryptSecret(key, { ...place, rowId: randomUUID() }, stored)).toThrow(AppError);
    expect(() => decryptSecret(key, { ...place, column: "other" }, stored)).toThrow(AppError);
  });

  it("refuses a changed ciphertext, a wrong key and an unknown version", () => {
    const stored = encryptSecret(key, place, "secret");
    const bytes = Buffer.from(stored.slice(3), "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(key, place, `v1:${bytes.toString("base64")}`)).toThrow(AppError);
    expect(() => decryptSecret(randomBytes(32), place, stored)).toThrow(AppError);
    expect(() => decryptSecret(key, place, stored.replace("v1:", "v2:"))).toThrow(AppError);
  });

  it("accepts only a 32-byte key", () => {
    expect(parseAesKey(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => parseAesKey(randomBytes(16).toString("base64"))).toThrow();
  });
});
