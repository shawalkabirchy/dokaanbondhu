import { describe, expect, it } from "vitest";
import { settingsPatchSchema, shopSettingsSchema, staffCreateSchema } from "./account";

describe("shop settings", () => {
  it("fills in every default for an empty settings object", () => {
    expect(shopSettingsSchema.parse({})).toEqual({
      staff_price_override: false,
      external_providers_allowed: false,
      voice: "aditi",
      default_language: "bn",
      evaluation_consent: false,
    });
  });

  it("lets the owner change only voice, external providers and the staff price override", () => {
    expect(settingsPatchSchema.safeParse({ staff_price_override: true }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ evaluation_consent: true }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("staff logins", () => {
  it("need a name, an email and a password of at least 8 characters", () => {
    expect(
      staffCreateSchema.safeParse({ name: "Rafiq", email: "rafiq@shop.test", password: "12345678" }).success,
    ).toBe(true);
    expect(
      staffCreateSchema.safeParse({ name: "Rafiq", email: "rafiq@shop.test", password: "short" }).success,
    ).toBe(false);
    expect(
      staffCreateSchema.safeParse({ name: "", email: "not-an-email", password: "12345678" }).success,
    ).toBe(false);
  });
});
