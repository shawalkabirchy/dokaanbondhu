import { z } from "zod";

// Health, the signed-in user, staff, settings and providers (spec 8.3, 8.8, 13.2).

export const healthSchema = z.object({
  status: z.enum(["ok", "down"]),
  version: z.string(),
  db: z.enum(["ok", "down"]),
  speech: z.enum(["ok", "down", "unknown"]),
  llm: z.enum(["ok", "down", "unknown"]),
});
export type Health = z.infer<typeof healthSchema>;

/** A shop's settings with every default filled in (spec 7.2). */
export const shopSettingsSchema = z.object({
  staff_price_override: z.boolean().default(false),
  external_providers_allowed: z.boolean().default(false),
  voice: z.string().min(1).default("aditi"),
  default_language: z.enum(["bn", "en"]).default("bn"),
  evaluation_consent: z.boolean().default(false),
});
export type ShopSettingsView = z.infer<typeof shopSettingsSchema>;

/** What the owner may change in the app; evaluation consent is admin CLI only (D41). */
export const settingsPatchSchema = z
  .object({
    voice: z.string().min(1).max(40),
    external_providers_allowed: z.boolean(),
    staff_price_override: z.boolean(),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, "nothing to change");

export const providerViewSchema = z.object({
  id: z.uuid(),
  job: z.enum(["llm", "stt", "tts"]),
  provider: z.string(),
  model: z.string().nullable(),
  scope: z.enum(["shop", "global"]),
  active: z.boolean(),
  external: z.boolean(),
  enabled: z.boolean(),
  priority: z.number().int().nullable(),
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const providersInUseSchema = z.object({
  llm: z.array(providerViewSchema), // in fallback order
  stt: providerViewSchema.nullable(),
  tts: providerViewSchema.nullable(),
});
export type ProvidersInUse = z.infer<typeof providersInUseSchema>;

export const userViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: z.enum(["owner", "staff"]),
  status: z.enum(["active", "disabled"]),
});
export type UserView = z.infer<typeof userViewSchema>;

export const meSchema = z.object({
  user: userViewSchema,
  shop: z.object({ id: z.uuid(), name: z.string(), market_area: z.string().nullable() }),
  settings: shopSettingsSchema,
  providers: providersInUseSchema,
});
export type Me = z.infer<typeof meSchema>;

export const staffCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    email: z.email().max(254),
    password: z.string().min(8).max(72),
    phone: z.string().trim().min(6).max(20).optional(),
  })
  .strict();
export type StaffCreate = z.infer<typeof staffCreateSchema>;

export const staffPatchSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();

export const providerSwitchSchema = z.object({ provider_id: z.uuid() }).strict();
