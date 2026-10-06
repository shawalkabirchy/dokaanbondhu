import { z } from "zod";

// Setup, the database half (spec 8.3, 11.1, 11.3, 11.4, 11.7): the connection, the schema map review with sample values
// as they will be spoken, the catalog sync and the stock-value formula. Secrets go in and never come back out.

export const connectionCreateSchema = z.object({
  kind: z.literal("db"),
  label: z.string().trim().min(1).max(60).optional(),
  dialect: z.enum(["postgres", "mysql"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
  /** verify-full by default; require is encrypted but not verified; disable only for localhost (spec 7.2). */
  ssl_mode: z.enum(["verify-full", "require", "disable"]).default("verify-full"),
  /** PEM, public: for a host whose certificate authority is private, such as Supabase. */
  ssl_ca: z.string().trim().max(20_000).optional(),
  pool_max: z.number().int().min(1).max(10).default(3),
});
export type ConnectionCreate = z.input<typeof connectionCreateSchema>;

export const connectionViewSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["db", "api"]),
  label: z.string().nullable(),
  dialect: z.enum(["postgres", "mysql"]).nullable(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  database: z.string().nullable(),
  username: z.string().nullable(),
  ssl_mode: z.enum(["verify-full", "require", "disable"]).nullable(),
  has_ssl_ca: z.boolean(),
  status: z.enum(["pending", "active", "error", "disabled"]),
  last_checked_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

export const connectionTestSchema = z.object({
  ok: z.boolean(),
  tables: z.number().int().optional(),
  error: z.string().optional(),
  connection: connectionViewSchema,
});
export type ConnectionTest = z.infer<typeof connectionTestSchema>;

const rowFilterSchema = z.object({
  table: z.string(),
  column: z.string(),
  op: z.enum(["is_null", "eq", "ne", "is_true"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

const joinSchema = z.object({
  table: z.string(),
  on: z.array(z.object({ left: z.string(), right: z.string() })).min(1),
  kind: z.enum(["parent", "child"]).optional(),
});

export const entityViewSchema = z.object({
  id: z.uuid(),
  concept: z.string(),
  host_table: z.string(),
  joins: z.array(joinSchema),
  row_filters: z.array(rowFilterSchema),
  confirmed: z.boolean(),
  fields: z.array(
    z.object({
      concept_field: z.string(),
      /** What the field holds: money (whole taka, D110), quantity, id, ref, text, number, boolean, time. */
      kind: z.string(),
      host_table: z.string(),
      host_column: z.string(),
      id_type: z.enum(["integer", "uuid", "text"]).nullable(),
      confirmed: z.boolean(),
      /** Up to three sample values as they will be spoken (a price as "৪,২০০ টাকা"). */
      samples: z.array(z.string()),
    }),
  ),
});
export type EntityView = z.infer<typeof entityViewSchema>;

export const schemaViewSchema = z.object({
  connection_id: z.uuid(),
  entities: z.array(entityViewSchema),
  /** Concepts with no proposal: not mapped, so never queried. */
  missing: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type SchemaView = z.infer<typeof schemaViewSchema>;

export const schemaProposeSchema = z.object({ connection_id: z.uuid() });

/** PUT /setup/schema/{entityId}: no entity confirms it as proposed; an entity corrects it (checked like a proposal). */
export const entityConfirmSchema = z.object({
  entity: z
    .object({
      host_table: z.string().min(1),
      joins: z.array(joinSchema.omit({ kind: true })).default([]),
      row_filters: z.array(rowFilterSchema).default([]),
      fields: z.array(
        z.object({
          concept_field: z.string().min(1),
          host_table: z.string().min(1),
          host_column: z.string().min(1),
        }),
      ),
    })
    .optional(),
});
export type EntityConfirm = z.input<typeof entityConfirmSchema>;

export const catalogSyncSchema = z.object({ connection_id: z.uuid() });
export const catalogSyncResultSchema = z.object({
  parts: z.number().int(),
  vehicles: z.number().int(),
  customers: z.number().int(),
  suppliers: z.number().int(),
  synced_at: z.string(),
});
export type CatalogSyncResult = z.infer<typeof catalogSyncResultSchema>;

export const reportsViewSchema = z.object({
  connection_id: z.uuid(),
  stock_value: z.object({
    /** Both fields are mapped, so the formula can be proposed. */
    available: z.boolean(),
    confirmed: z.boolean(),
    /** The formula's result now, in whole taka, for the owner to compare with the app. */
    current_taka: z.number().nullable(),
  }),
  /** Reports answered with "see this in your app" (spec 11.7). */
  see_in_app: z.array(z.string()),
});
export type ReportsView = z.infer<typeof reportsViewSchema>;

export const reportConfirmSchema = z.object({ connection_id: z.uuid(), name: z.literal("stock_value") });

// Price levels (D121): each value of the customers' price tier (or type) that decides their price, the level the word
// list or the owner gave it, and how many customers have it; a value nobody has named is answered at retail until the
// owner chooses.
export const priceTierSchema = z.enum(["retail", "garage", "wholesale"]);

export const priceLevelsViewSchema = z.object({
  connection_id: z.uuid(),
  levels: z.array(
    z.object({
      value: z.string(),
      customers: z.number().int(),
      tier: priceTierSchema.nullable(),
      decided_by: z.enum(["owner", "words"]).nullable(),
    }),
  ),
});
export type PriceLevelsView = z.infer<typeof priceLevelsViewSchema>;

export const priceLevelDecisionSchema = z
  .object({ connection_id: z.uuid(), value: z.string().min(1).max(200), tier: priceTierSchema })
  .strict();

// Words the assistant learned (D102, D105), for the owner to add or dismiss: the listening check's suggestions, and
// the words learned from answered questions once seen twice; and what the listening check has done.
export const wordSuggestionSchema = z.object({
  id: z.uuid(),
  heard: z.string(),
  concept: z.enum(["part_type", "vehicle_model", "quality", "position", "unit", "brand"]),
  value: z.string(),
  origin: z.enum(["answers", "listening"]),
  seen: z.number().int(),
});
export type WordSuggestion = z.infer<typeof wordSuggestionSchema>;

export const wordsViewSchema = z.object({
  suggestions: z.array(wordSuggestionSchema),
  /** The listening check: names checked, and the spellings it found (suggested to the owner). */
  checked: z.object({ names: z.number().int(), words: z.number().int() }),
});
export type WordsView = z.infer<typeof wordsViewSchema>;

export const wordDecisionSchema = z.object({ action: z.enum(["add", "dismiss"]) }).strict();
