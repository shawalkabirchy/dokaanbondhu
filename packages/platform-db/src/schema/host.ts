import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, timestamptz, updatedAt } from "./columns";
import {
  AUTH_TYPES,
  CAPABILITY_KINDS,
  CAPABILITY_SOURCES,
  CATALOG_CONCEPTS,
  CONCEPTS,
  CONNECTION_KINDS,
  CONNECTION_STATUSES,
  DIALECTS,
  FITMENT_EXTRA_SOURCES,
  ID_TYPES,
  PARAM_LOCATIONS,
  REQUIRED_ROLES,
  SETUP_TOKEN_PURPOSES,
  SSL_MODES,
} from "./enums";
import { shops } from "./shops";

// A shop's host apps: connections, the confirmed schema map, capabilities, the catalog cache and extras (spec 7.2).

const shopId = () =>
  uuid("shop_id")
    .notNull()
    .references(() => shops.id);

export const connections = pgTable(
  "connections",
  {
    id: id(),
    shopId: shopId(),
    kind: text("kind").notNull(),
    label: text("label"),
    // database connections
    dialect: text("dialect"),
    host: text("host"),
    port: integer("port"),
    database: text("database"),
    username: text("username"),
    sslMode: text("ssl_mode").default("verify-full"),
    sslCa: text("ssl_ca"), // PEM, public; for a host whose certificate authority is private, such as Supabase
    // API connections
    baseUrl: text("base_url"),
    authType: text("auth_type"),
    authHeader: text("auth_header"),
    loginConfig: jsonb("login_config"),
    secretEncrypted: text("secret_encrypted").notNull(), // spec 13.5
    features: jsonb("features")
      .notNull()
      .default(sql`'{}'::jsonb`), // the host feature list
    poolMax: integer("pool_max").notNull().default(3),
    status: text("status").notNull(),
    lastCheckedAt: timestamptz("last_checked_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [
    check("connections_kind_check", oneOf(t.kind, CONNECTION_KINDS)),
    check("connections_dialect_check", oneOf(t.dialect, DIALECTS)),
    check("connections_ssl_mode_check", oneOf(t.sslMode, SSL_MODES)),
    check("connections_auth_type_check", oneOf(t.authType, AUTH_TYPES)),
    check("connections_status_check", oneOf(t.status, CONNECTION_STATUSES)),
    index("connections_shop_id_idx").on(t.shopId),
  ],
);

export const schemaEntities = pgTable(
  "schema_entities",
  {
    id: id(),
    shopId: shopId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    concept: text("concept").notNull(),
    hostTable: text("host_table").notNull(),
    joins: jsonb("joins")
      .notNull()
      .default(sql`'[]'::jsonb`), // [{ table, on: [{ left, right }] }]
    rowFilters: jsonb("row_filters")
      .notNull()
      .default(sql`'[]'::jsonb`), // [{ table, column, op, value }] (D21)
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedAt: timestamptz("confirmed_at"),
    confirmedBy: uuid("confirmed_by"),
  },
  (t) => [
    check("schema_entities_concept_check", oneOf(t.concept, CONCEPTS)),
    unique("schema_entities_connection_concept_unique").on(t.connectionId, t.concept),
    index("schema_entities_shop_id_idx").on(t.shopId),
  ],
);

export const schemaFields = pgTable(
  "schema_fields",
  {
    id: id(),
    shopId: shopId(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => schemaEntities.id),
    conceptField: text("concept_field").notNull(),
    hostTable: text("host_table").notNull(), // the primary or a joined table
    hostColumn: text("host_column").notNull(),
    dataType: text("data_type"),
    idType: text("id_type"),
    valueScale: integer("value_scale").notNull().default(1),
    confirmed: boolean("confirmed").notNull().default(false),
  },
  (t) => [
    check("schema_fields_id_type_check", oneOf(t.idType, ID_TYPES)),
    unique("schema_fields_entity_field_unique").on(t.entityId, t.conceptField),
    index("schema_fields_shop_id_idx").on(t.shopId),
  ],
);

export const capabilities = pgTable(
  "capabilities",
  {
    id: id(),
    shopId: shopId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull(),
    httpMethod: text("http_method"),
    path: text("path"),
    operationId: text("operation_id"),
    source: text("source").notNull(),
    requestSchema: jsonb("request_schema"),
    responseSchema: jsonb("response_schema"),
    schemaHash: text("schema_hash").notNull(),
    requiredRole: text("required_role").notNull().default("staff"),
    template: text("template"), // confirmation template kind (spec 11.10)
    compensatingCapabilityId: uuid("compensating_capability_id").references(
      (): AnyPgColumn => capabilities.id,
    ),
    compensation: jsonb("compensation"), // { id_from, body }
    preview: jsonb("preview"),
    readBack: jsonb("read_back"),
    enabled: boolean("enabled").notNull().default(false),
    verifiedAt: timestamptz("verified_at"),
    verificationReport: jsonb("verification_report"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("capabilities_kind_check", oneOf(t.kind, CAPABILITY_KINDS)),
    check("capabilities_source_check", oneOf(t.source, CAPABILITY_SOURCES)),
    check("capabilities_required_role_check", oneOf(t.requiredRole, REQUIRED_ROLES)),
    unique("capabilities_connection_name_unique").on(t.connectionId, t.name),
    index("capabilities_shop_id_idx").on(t.shopId),
    index("capabilities_compensating_capability_id_idx").on(t.compensatingCapabilityId),
  ],
);

export const capabilityParams = pgTable(
  "capability_params",
  {
    id: id(),
    shopId: shopId(),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id),
    path: text("path").notNull(), // JSON path, e.g. items[].part_id
    location: text("location").notNull(),
    type: text("type").notNull(),
    required: boolean("required").notNull(),
    enumValues: jsonb("enum_values"),
    entityConcept: text("entity_concept"),
    semanticSlot: text("semantic_slot"), // spec 9.6
    safetyCritical: boolean("safety_critical").notNull().default(false),
    valueScale: integer("value_scale").notNull().default(1),
    spokenMap: jsonb("spoken_map"),
    confirmed: boolean("confirmed").notNull().default(false),
  },
  (t) => [
    check("capability_params_location_check", oneOf(t.location, PARAM_LOCATIONS)),
    unique("capability_params_capability_path_unique").on(t.capabilityId, t.path),
    index("capability_params_shop_id_idx").on(t.shopId),
  ],
);

export const catalogCache = pgTable(
  "catalog_cache",
  {
    id: id(),
    shopId: shopId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    concept: text("concept").notNull(),
    hostId: text("host_id").notNull(),
    displayName: text("display_name").notNull(),
    displayNameBn: text("display_name_bn"),
    partNumbers: text("part_numbers").array(),
    phoneticKey: text("phonetic_key").notNull(),
    attrs: jsonb("attrs"),
    syncedAt: timestamptz("synced_at").notNull(),
  },
  (t) => [
    check("catalog_cache_concept_check", oneOf(t.concept, CATALOG_CONCEPTS)),
    unique("catalog_cache_connection_concept_host_unique").on(t.connectionId, t.concept, t.hostId),
    index("catalog_cache_shop_id_idx").on(t.shopId),
  ],
);

export const fitmentExtra = pgTable(
  "fitment_extra",
  {
    id: id(),
    shopId: shopId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    hostPartId: text("host_part_id").notNull(),
    make: text("make").notNull(),
    model: text("model").notNull(),
    yearFrom: smallint("year_from"),
    yearTo: smallint("year_to"),
    engineCode: text("engine_code"),
    source: text("source").notNull(),
    verified: boolean("verified").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check("fitment_extra_source_check", oneOf(t.source, FITMENT_EXTRA_SOURCES)),
    index("fitment_extra_shop_id_idx").on(t.shopId),
    index("fitment_extra_connection_id_idx").on(t.connectionId),
  ],
);

export const rackExtra = pgTable(
  "rack_extra",
  {
    id: id(),
    shopId: shopId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    hostPartId: text("host_part_id").notNull(),
    rackLocation: text("rack_location").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("rack_extra_connection_part_unique").on(t.connectionId, t.hostPartId),
    index("rack_extra_shop_id_idx").on(t.shopId),
  ],
);

/** One-time tokens for the scanner upload, which carries a token instead of a login (spec 7.3, 16.3). */
export const setupTokens = pgTable(
  "setup_tokens",
  {
    id: id(),
    shopId: shopId(),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    check("setup_tokens_purpose_check", oneOf(t.purpose, SETUP_TOKEN_PURPOSES)),
    index("setup_tokens_shop_id_idx").on(t.shopId),
  ],
);

/** Owner-confirmed report formulas, structured JSON and never SQL text (D21, D44; spec 11.7). */
export const reportFormulas = pgTable(
  "report_formulas",
  {
    id: id(),
    shopId: shopId(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id),
    name: text("name").notNull(),
    definition: jsonb("definition").notNull(),
    confirmedAt: timestamptz("confirmed_at"),
    confirmedBy: uuid("confirmed_by"),
  },
  (t) => [
    unique("report_formulas_connection_name_unique").on(t.connectionId, t.name),
    index("report_formulas_shop_id_idx").on(t.shopId),
  ],
);
