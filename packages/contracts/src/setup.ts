import { z } from "zod";

// Setup (spec 8.3): the database half (11.1, 11.3, 11.4, 11.7: the connection, the schema map review with sample values
// as they will be spoken, the catalog sync and the stock-value formula) and the API half (11.8, 11.12, 11.13: the API
// connection, the capabilities imported from its OpenAPI document, the host feature list). Secrets go in and never
// come back out.

export const dbConnectionCreateSchema = z.object({
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

/** An API connection: api_key sends the secret in a named header, bearer as Authorization (spec 11.12, D134). */
export const apiConnectionCreateSchema = z.object({
  kind: z.literal("api"),
  label: z.string().trim().min(1).max(60).optional(),
  /** https, or http only for localhost; the operations' paths are added to it. */
  base_url: z.string().trim().min(1).max(500),
  auth_type: z.enum(["api_key", "bearer"]),
  /** api_key only; left out, the connection test takes it from the document's apiKey scheme. */
  auth_header: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
  secret: z.string().min(1).max(2000),
});

export const connectionCreateSchema = z.discriminatedUnion("kind", [
  dbConnectionCreateSchema,
  apiConnectionCreateSchema,
]);
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
  base_url: z.string().nullable(),
  auth_type: z.enum(["api_key", "bearer", "session"]).nullable(),
  auth_header: z.string().nullable(),
  status: z.enum(["pending", "active", "error", "disabled"]),
  last_checked_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

export const connectionTestSchema = z.object({
  ok: z.boolean(),
  tables: z.number().int().optional(),
  /** API connections: the document's operations, and whether the host accepted the secret. */
  operations: z.number().int().optional(),
  key: z.enum(["accepted", "refused", "not_checked"]).optional(),
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

// The app's own words (D121, D122): each value it writes for a customer's price level (its tier, else its type) and a
// part's quality, position and unit, with ours from the word list or the owner and how many customers or parts have
// it. A value nobody has named is retail (price) or is never matched (the rest) until the owner chooses.
export const appWordConceptSchema = z.enum(["price_tier", "quality", "position", "unit"]);
export type AppWordConceptName = z.infer<typeof appWordConceptSchema>;

export const appWordOurValues = {
  price_tier: ["retail", "paikari"], // the only two price kinds the owner sees (D145)
  quality: ["genuine", "aftermarket", "reconditioned", "used"],
  position: ["front", "rear", "left", "right"],
  unit: ["piece", "set", "pair", "hali", "dozen", "liter", "tin", "box"],
} as const satisfies Record<AppWordConceptName, readonly string[]>;

const appWordSchema = z.object({
  value: z.string(),
  count: z.number().int(),
  our: z.string().nullable(),
  decided_by: z.enum(["owner", "words"]).nullable(),
});

export const appWordsViewSchema = z.object({
  connection_id: z.uuid(),
  groups: z.object({
    price_tier: z.array(appWordSchema),
    quality: z.array(appWordSchema),
    position: z.array(appWordSchema),
    unit: z.array(appWordSchema),
  }),
});
export type AppWordsView = z.infer<typeof appWordsViewSchema>;

export const appWordDecisionSchema = z
  .object({
    connection_id: z.uuid(),
    concept: appWordConceptSchema,
    value: z.string().min(1).max(200),
    our: z.string(),
  })
  .strict()
  .refine((body) => (appWordOurValues[body.concept] as readonly string[]).includes(body.our), {
    path: ["our"],
    message: "not one of ours for this concept",
  });

// Which of the app's trade prices is paikari (D143, D146): the map's garage and wholesale price columns, each with one
// part's price in it as an example. The owner is asked only when there are two.
export const paikariFieldSchema = z.enum(["garage_price", "wholesale_price"]);
export type PaikariFieldName = z.infer<typeof paikariFieldSchema>;

export const paikariPriceViewSchema = z.object({
  connection_id: z.uuid(),
  options: z.array(
    z.object({
      field: paikariFieldSchema,
      /** The column as the app names it ("dealer_rate"). */
      column: z.string(),
      example: z.object({ part: z.string(), taka: z.number().int() }).nullable(),
    }),
  ),
  /** null until the owner chooses: the garage price, else the wholesale price. */
  chosen: paikariFieldSchema.nullable(),
});
export type PaikariPriceView = z.infer<typeof paikariPriceViewSchema>;

export const paikariPriceChoiceSchema = z
  .object({ connection_id: z.uuid(), field: paikariFieldSchema })
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

// The API half (spec 11.8, 11.13; D133, D134): capabilities imported from the host's OpenAPI document, each with the
// proposals the owner confirms, and the host feature list.

/** Confirmation template kinds (spec 11.10). */
export const TEMPLATE_KINDS = [
  "sale",
  "payment",
  "stock_in",
  "return",
  "price_update",
  "add_fitment",
  "generic",
] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Semantic slots a parameter is filled from (spec 9.6); a required parameter without one is asked as extra.<name>. */
export const SEMANTIC_SLOTS = [
  "customer",
  "supplier",
  "items",
  "part",
  "vehicle",
  "payment",
  "amount",
  "prices",
  "sale_ref",
  "refund",
  "reason",
  "note",
] as const;
export type SemanticSlot = (typeof SEMANTIC_SLOTS)[number];

/** The schema map's concepts an ID parameter may name (spec 7.2). */
export const ENTITY_CONCEPTS = [
  "Part",
  "Vehicle",
  "Fitment",
  "StockItem",
  "Price",
  "Customer",
  "Sale",
  "SaleItem",
  "Return",
  "Payment",
  "Supplier",
  "Purchase",
] as const;

export const capabilityParamViewSchema = z.object({
  id: z.uuid(),
  path: z.string(),
  location: z.enum(["body", "query", "path"]),
  type: z.string(),
  required: z.boolean(),
  enum_values: z.array(z.string()).nullable(),
  entity_concept: z.string().nullable(),
  semantic_slot: z.string().nullable(),
  safety_critical: z.boolean(),
  /** Spoken word -> the host's value. */
  spoken_map: z.record(z.string(), z.string()).nullable(),
  confirmed: z.boolean(),
});
export type CapabilityParamView = z.infer<typeof capabilityParamViewSchema>;

/** Another capability by its name, and where its ID is read in this one's answer (sale.id). */
const operationRefSchema = z.object({
  operation: z.string().min(1).max(100),
  id_from: z.string().min(1).max(200),
});

export const capabilityViewSchema = z.object({
  id: z.uuid(),
  connection_id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(["read", "write"]),
  http_method: z.string().nullable(),
  path: z.string().nullable(),
  source: z.enum(["openapi", "scanner", "demo"]),
  schema_hash: z.string(),
  required_role: z.enum(["staff", "owner"]),
  template: z.enum(TEMPLATE_KINDS).nullable(),
  enabled: z.boolean(),
  verified_at: z.string().nullable(),
  /** The host can run it as a dry run. */
  dry_run: z.boolean(),
  /** Undo: the compensating capability and the body it is sent (placeholders such as {undo_reason}). */
  compensation: operationRefSchema
    .extend({ capability_id: z.uuid().nullable(), body: z.record(z.string(), z.unknown()) })
    .nullable(),
  read_back: operationRefSchema.nullable(),
  /** Another capability's compensation: only undo calls it, it is never a tool (D52). */
  is_compensation: z.boolean(),
  params: z.array(capabilityParamViewSchema),
});
export type CapabilityView = z.infer<typeof capabilityViewSchema>;

/** The host feature list (spec 11.13, the architecture's example); every key is optional. */
export const hostFeaturesSchema = z
  .object({
    openapi: z.string().startsWith("/").max(200),
    dry_run: z.string().max(200),
    idempotency_header: z.string().max(64),
    bangla_errors: z.string().max(200),
    acting_user_header: z.string().max(64),
    sync_status: z.string().max(200),
    reports: z.array(z.string().max(60)).max(20),
    report_path: z.string().max(200),
  })
  .partial()
  .strict();
export type HostFeatures = z.infer<typeof hostFeaturesSchema>;

/** A detected list keeps only the keys and values the feature list knows. */
export function knownFeatures(detected: Record<string, unknown>): HostFeatures {
  const shape = hostFeaturesSchema.shape;
  const known: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detected)) {
    const field = shape[key as keyof typeof shape];
    if (field && value !== undefined && field.safeParse(value).success) known[key] = value;
  }
  return known as HostFeatures;
}

export const discoverSchema = z.object({ connection_id: z.uuid() }).strict();

export const discoverResultSchema = z.object({
  connection_id: z.uuid(),
  added: z.array(z.string()),
  /** The request changed: switched off until the sandbox verifies it again. */
  changed: z.array(z.string()),
  kept: z.array(z.string()),
  /** No longer in the document: switched off. */
  removed: z.array(z.string()),
  /** A compensation names an operation the document does not have. */
  unresolved: z.array(z.string()),
  detected_features: hostFeaturesSchema,
  features_confirmed: z.boolean(),
  capabilities: z.array(capabilityViewSchema),
});
export type DiscoverResult = z.infer<typeof discoverResultSchema>;

export const capabilityPatchSchema = z
  .object({
    enabled: z.boolean(),
    required_role: z.enum(["staff", "owner"]),
    template: z.enum(TEMPLATE_KINDS),
    compensation: operationRefSchema
      .extend({ body: z.record(z.string(), z.unknown()).default({}) })
      .nullable(),
    read_back: operationRefSchema.nullable(),
    params: z
      .array(
        z
          .object({
            path: z.string().min(1).max(200),
            entity_concept: z.enum(ENTITY_CONCEPTS).nullable().optional(),
            semantic_slot: z.enum(SEMANTIC_SLOTS).nullable().optional(),
            spoken_map: z
              .record(z.string().trim().min(1).max(60), z.string().min(1).max(100))
              .nullable()
              .optional(),
            confirmed: z.boolean().optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .partial()
  .strict();
export type CapabilityPatch = z.infer<typeof capabilityPatchSchema>;

export const featuresViewSchema = z.object({
  connections: z.array(
    z.object({
      connection_id: z.uuid(),
      label: z.string().nullable(),
      features: hostFeaturesSchema,
      /** null while the list is only detected. */
      confirmed_at: z.string().nullable(),
    }),
  ),
});
export type FeaturesView = z.infer<typeof featuresViewSchema>;

export const featuresPutSchema = z.object({ connection_id: z.uuid(), features: hostFeaturesSchema }).strict();
