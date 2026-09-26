import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "@dokaanbondhu/core";

// Stored secrets (spec 13.5): AES-256-GCM under AES_KEY. The stored text is "v1:" + base64(IV || tag || ciphertext),
// with the additional data "<table>:<row id>:<column>", so a ciphertext copied to another row does not decrypt.

const VERSION = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretPlace {
  table: string;
  rowId: string; // made by the application before the insert
  column: string;
}

const placeOf = (place: SecretPlace) => Buffer.from(`${place.table}:${place.rowId}:${place.column}`, "utf8");

/** Reads AES_KEY: 32 random bytes, base64. */
export function parseAesKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error("AES_KEY must be 32 bytes, base64");
  return key;
}

export function encryptSecret(key: Buffer, place: SecretPlace, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(placeOf(place));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(key: Buffer, place: SecretPlace, stored: string): string {
  if (!stored.startsWith(VERSION))
    throw new AppError("INTERNAL", 500, "errors.INTERNAL", { reason: "secret version" });
  const data = Buffer.from(stored.slice(VERSION.length), "base64");
  if (data.length < IV_BYTES + TAG_BYTES) {
    throw new AppError("INTERNAL", 500, "errors.INTERNAL", { reason: "secret too short" });
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES));
    decipher.setAAD(placeOf(place));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new AppError("INTERNAL", 500, "errors.INTERNAL", { reason: "secret does not decrypt" });
  }
}
