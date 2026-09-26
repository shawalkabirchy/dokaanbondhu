import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, id, oneOf, timestamptz, updatedAt } from "./columns";
import {
  ACTION_STATUSES,
  ALIAS_SOURCES,
  ALIAS_TARGETS,
  CHANNELS,
  CONVERSATION_STATES,
  FRAME_STATUSES,
  MESSAGE_ROLES,
  PROVIDER_JOBS,
  PROVIDERS,
  VERIFY_STATUSES,
} from "./enums";
import { capabilities } from "./host";
import { shops, users } from "./shops";

// Conversations, frames, actions, aliases and AI providers (spec 7.2).

const shopId = () =>
  uuid("shop_id")
    .notNull()
    .references(() => shops.id);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    shopId: shopId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channel: text("channel").notNull(),
    state: text("state").notNull().default("IDLE"),
    context: jsonb("context")
      .notNull()
      .default(sql`'{}'::jsonb`), // current_vehicle, current_customer, updated_at
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    lastActiveAt: timestamptz("last_active_at").notNull().defaultNow(),
  },
  (t) => [
    check("conversations_channel_check", oneOf(t.channel, CHANNELS)),
    check("conversations_state_check", oneOf(t.state, CONVERSATION_STATES)),
    index("conversations_shop_id_idx").on(t.shopId),
    index("conversations_user_id_idx").on(t.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    shopId: shopId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    turnId: uuid("turn_id").notNull(),
    role: text("role").notNull(),
    text: text("text"),
    asrNbest: jsonb("asr_nbest"), // only while the shop's evaluation_consent is on (D41)
    meta: jsonb("meta"), // stage timings, providers used, fallbacks, questions asked
    createdAt: createdAt(),
  },
  (t) => [
    check("messages_role_check", oneOf(t.role, MESSAGE_ROLES)),
    index("messages_shop_id_idx").on(t.shopId),
    index("messages_conversation_id_idx").on(t.conversationId),
    index("messages_created_at_idx").on(t.createdAt),
  ],
);

export const requestFrames = pgTable(
  "request_frames",
  {
    id: id(),
    shopId: shopId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    intent: text("intent").notNull(),
    capabilityId: uuid("capability_id").references(() => capabilities.id),
    slots: jsonb("slots").notNull(),
    asking: text("asking"),
    attempts: jsonb("attempts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("request_frames_status_check", oneOf(t.status, FRAME_STATUSES)),
    uniqueIndex("request_frames_one_open_idx")
      .on(t.conversationId)
      .where(sql`${t.status} in ('active', 'confirming')`),
    index("request_frames_shop_id_idx").on(t.shopId),
    index("request_frames_capability_id_idx").on(t.capabilityId),
  ],
);

export const actionLogs = pgTable(
  "action_logs",
  {
    id: id(),
    shopId: shopId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id").references(() => conversations.id),
    turnId: uuid("turn_id"),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id),
    request: jsonb("request"),
    preview: jsonb("preview"),
    response: jsonb("response"),
    status: text("status").notNull(),
    verifyStatus: text("verify_status"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    undoOf: uuid("undo_of").references((): AnyPgColumn => actionLogs.id),
    confirmedAt: timestamptz("confirmed_at"),
    doneAt: timestamptz("done_at"),
    undoneAt: timestamptz("undone_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("action_logs_status_check", oneOf(t.status, ACTION_STATUSES)),
    check("action_logs_verify_status_check", oneOf(t.verifyStatus, VERIFY_STATUSES)),
    index("action_logs_shop_id_idx").on(t.shopId),
    index("action_logs_user_id_idx").on(t.userId),
    index("action_logs_conversation_id_idx").on(t.conversationId),
    index("action_logs_capability_id_idx").on(t.capabilityId),
    index("action_logs_undo_of_idx").on(t.undoOf),
  ],
);

/** Aliases: shop_id null = a global row every shop may read. */
export const aliases = pgTable(
  "aliases",
  {
    id: id(),
    shopId: uuid("shop_id").references(() => shops.id),
    aliasText: text("alias_text").notNull(),
    aliasNormalized: text("alias_normalized").notNull(),
    aliasPhonetic: text("alias_phonetic").notNull(),
    targetConcept: text("target_concept").notNull(),
    targetValue: text("target_value").notNull(),
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("aliases_target_concept_check", oneOf(t.targetConcept, ALIAS_TARGETS)),
    check("aliases_source_check", oneOf(t.source, ALIAS_SOURCES)),
    index("aliases_shop_id_idx").on(t.shopId),
  ],
);

/**
 * AI providers: shop_id null = the global default. At most one active speech provider per job and shop: a unique
 * index with NULLS NOT DISTINCT, which the custom migration creates because Drizzle cannot declare it.
 */
export const aiProviders = pgTable(
  "ai_providers",
  {
    id: id(),
    shopId: uuid("shop_id").references(() => shops.id),
    job: text("job").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    baseUrl: text("base_url"),
    secretEncrypted: text("secret_encrypted"),
    options: jsonb("options")
      .notNull()
      .default(sql`'{}'::jsonb`), // auth header names, voice IDs, extra fields
    priority: integer("priority"), // LLM order
    active: boolean("active").notNull().default(false), // speech: the one provider in use
    external: boolean("external").notNull(), // a commercial service outside the project
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check("ai_providers_job_check", oneOf(t.job, PROVIDER_JOBS)),
    check("ai_providers_provider_check", oneOf(t.provider, PROVIDERS)),
    index("ai_providers_shop_id_idx").on(t.shopId),
  ],
);
