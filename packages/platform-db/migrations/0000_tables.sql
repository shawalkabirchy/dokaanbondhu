CREATE TABLE "action_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"turn_id" uuid,
	"capability_id" uuid NOT NULL,
	"request" jsonb,
	"preview" jsonb,
	"response" jsonb,
	"status" text NOT NULL,
	"verify_status" text,
	"idempotency_key" uuid NOT NULL,
	"undo_of" uuid,
	"confirmed_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_logs_status_check" CHECK ("action_logs"."status" in ('pending', 'done', 'failed', 'review', 'cancelled', 'undone')),
	CONSTRAINT "action_logs_verify_status_check" CHECK ("action_logs"."verify_status" in ('ok', 'mismatch', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid,
	"job" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"base_url" text,
	"secret_encrypted" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer,
	"active" boolean DEFAULT false NOT NULL,
	"external" boolean NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_job_check" CHECK ("ai_providers"."job" in ('llm', 'stt', 'tts')),
	CONSTRAINT "ai_providers_provider_check" CHECK ("ai_providers"."provider" in ('vllm', 'cloudflare', 'deepseek', 'openai', 'openrouter', 'speech_worker', 'elevenlabs'))
);
--> statement-breakpoint
CREATE TABLE "aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid,
	"alias_text" text NOT NULL,
	"alias_normalized" text NOT NULL,
	"alias_phonetic" text NOT NULL,
	"target_concept" text NOT NULL,
	"target_value" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliases_target_concept_check" CHECK ("aliases"."target_concept" in ('part_type', 'vehicle_model', 'quality', 'position', 'unit', 'brand')),
	CONSTRAINT "aliases_source_check" CHECK ("aliases"."source" in ('global', 'owner', 'host'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'IDLE' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_channel_check" CHECK ("conversations"."channel" in ('voice', 'chat')),
	CONSTRAINT "conversations_state_check" CHECK ("conversations"."state" in ('IDLE', 'LISTENING', 'UNDERSTANDING', 'CLARIFYING', 'CONFIRMING', 'EXECUTING', 'RESPONDING'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text,
	"asr_nbest" jsonb,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "request_frames" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"capability_id" uuid,
	"slots" jsonb NOT NULL,
	"asking" text,
	"attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_frames_status_check" CHECK ("request_frames"."status" in ('active', 'set_aside', 'confirming', 'done', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"http_method" text,
	"path" text,
	"operation_id" text,
	"source" text NOT NULL,
	"request_schema" jsonb,
	"response_schema" jsonb,
	"schema_hash" text NOT NULL,
	"required_role" text DEFAULT 'staff' NOT NULL,
	"template" text,
	"compensating_capability_id" uuid,
	"compensation" jsonb,
	"preview" jsonb,
	"read_back" jsonb,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capabilities_connection_name_unique" UNIQUE("connection_id","name"),
	CONSTRAINT "capabilities_kind_check" CHECK ("capabilities"."kind" in ('read', 'write')),
	CONSTRAINT "capabilities_source_check" CHECK ("capabilities"."source" in ('openapi', 'scanner', 'demo')),
	CONSTRAINT "capabilities_required_role_check" CHECK ("capabilities"."required_role" in ('staff', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "capability_params" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"path" text NOT NULL,
	"location" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean NOT NULL,
	"enum_values" jsonb,
	"entity_concept" text,
	"semantic_slot" text,
	"safety_critical" boolean DEFAULT false NOT NULL,
	"value_scale" integer DEFAULT 1 NOT NULL,
	"spoken_map" jsonb,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "capability_params_capability_path_unique" UNIQUE("capability_id","path"),
	CONSTRAINT "capability_params_location_check" CHECK ("capability_params"."location" in ('body', 'query', 'path'))
);
--> statement-breakpoint
CREATE TABLE "catalog_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"concept" text NOT NULL,
	"host_id" text NOT NULL,
	"display_name" text NOT NULL,
	"display_name_bn" text,
	"part_numbers" text[],
	"phonetic_key" text NOT NULL,
	"attrs" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_cache_connection_concept_host_unique" UNIQUE("connection_id","concept","host_id"),
	CONSTRAINT "catalog_cache_concept_check" CHECK ("catalog_cache"."concept" in ('part', 'vehicle', 'customer', 'supplier'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"dialect" text,
	"host" text,
	"port" integer,
	"database" text,
	"username" text,
	"ssl_mode" text DEFAULT 'verify-full',
	"ssl_ca" text,
	"base_url" text,
	"auth_type" text,
	"auth_header" text,
	"login_config" jsonb,
	"secret_encrypted" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pool_max" integer DEFAULT 3 NOT NULL,
	"status" text NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_kind_check" CHECK ("connections"."kind" in ('db', 'api')),
	CONSTRAINT "connections_dialect_check" CHECK ("connections"."dialect" in ('postgres', 'mysql')),
	CONSTRAINT "connections_ssl_mode_check" CHECK ("connections"."ssl_mode" in ('verify-full', 'require', 'disable')),
	CONSTRAINT "connections_auth_type_check" CHECK ("connections"."auth_type" in ('api_key', 'bearer', 'session')),
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('pending', 'active', 'error', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "fitment_extra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"host_part_id" text NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"year_from" smallint,
	"year_to" smallint,
	"engine_code" text,
	"source" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fitment_extra_source_check" CHECK ("fitment_extra"."source" in ('parsed', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "rack_extra" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"host_part_id" text NOT NULL,
	"rack_location" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rack_extra_connection_part_unique" UNIQUE("connection_id","host_part_id")
);
--> statement-breakpoint
CREATE TABLE "report_formulas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	CONSTRAINT "report_formulas_connection_name_unique" UNIQUE("connection_id","name")
);
--> statement-breakpoint
CREATE TABLE "schema_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"concept" text NOT NULL,
	"host_table" text NOT NULL,
	"joins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"row_filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	CONSTRAINT "schema_entities_connection_concept_unique" UNIQUE("connection_id","concept"),
	CONSTRAINT "schema_entities_concept_check" CHECK ("schema_entities"."concept" in ('Part', 'Vehicle', 'Fitment', 'StockItem', 'Price', 'Customer', 'Sale', 'SaleItem', 'Return', 'Payment', 'Supplier', 'Purchase'))
);
--> statement-breakpoint
CREATE TABLE "schema_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"concept_field" text NOT NULL,
	"host_table" text NOT NULL,
	"host_column" text NOT NULL,
	"data_type" text,
	"id_type" text,
	"value_scale" integer DEFAULT 1 NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "schema_fields_entity_field_unique" UNIQUE("entity_id","concept_field"),
	CONSTRAINT "schema_fields_id_type_check" CHECK ("schema_fields"."id_type" in ('integer', 'uuid', 'text'))
);
--> statement-breakpoint
CREATE TABLE "setup_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	CONSTRAINT "setup_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "setup_tokens_purpose_check" CHECK ("setup_tokens"."purpose" in ('scanner_upload'))
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"market_area" text,
	"owner_user_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"auth_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('owner', 'staff')),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_undo_of_action_logs_id_fk" FOREIGN KEY ("undo_of") REFERENCES "public"."action_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_frames" ADD CONSTRAINT "request_frames_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_frames" ADD CONSTRAINT "request_frames_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_frames" ADD CONSTRAINT "request_frames_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_compensating_capability_id_capabilities_id_fk" FOREIGN KEY ("compensating_capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_params" ADD CONSTRAINT "capability_params_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_params" ADD CONSTRAINT "capability_params_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_cache" ADD CONSTRAINT "catalog_cache_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_cache" ADD CONSTRAINT "catalog_cache_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitment_extra" ADD CONSTRAINT "fitment_extra_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitment_extra" ADD CONSTRAINT "fitment_extra_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_extra" ADD CONSTRAINT "rack_extra_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_extra" ADD CONSTRAINT "rack_extra_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_formulas" ADD CONSTRAINT "report_formulas_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_formulas" ADD CONSTRAINT "report_formulas_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_entities" ADD CONSTRAINT "schema_entities_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_entities" ADD CONSTRAINT "schema_entities_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_fields" ADD CONSTRAINT "schema_fields_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schema_fields" ADD CONSTRAINT "schema_fields_entity_id_schema_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."schema_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_logs_shop_id_idx" ON "action_logs" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "action_logs_user_id_idx" ON "action_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "action_logs_conversation_id_idx" ON "action_logs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "action_logs_capability_id_idx" ON "action_logs" USING btree ("capability_id");--> statement-breakpoint
CREATE INDEX "action_logs_undo_of_idx" ON "action_logs" USING btree ("undo_of");--> statement-breakpoint
CREATE INDEX "ai_providers_shop_id_idx" ON "ai_providers" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "aliases_shop_id_idx" ON "aliases" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "conversations_shop_id_idx" ON "conversations" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_shop_id_idx" ON "messages" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "request_frames_one_open_idx" ON "request_frames" USING btree ("conversation_id") WHERE "request_frames"."status" in ('active', 'confirming');--> statement-breakpoint
CREATE INDEX "request_frames_shop_id_idx" ON "request_frames" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "request_frames_capability_id_idx" ON "request_frames" USING btree ("capability_id");--> statement-breakpoint
CREATE INDEX "capabilities_shop_id_idx" ON "capabilities" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "capabilities_compensating_capability_id_idx" ON "capabilities" USING btree ("compensating_capability_id");--> statement-breakpoint
CREATE INDEX "capability_params_shop_id_idx" ON "capability_params" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "catalog_cache_shop_id_idx" ON "catalog_cache" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "connections_shop_id_idx" ON "connections" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "fitment_extra_shop_id_idx" ON "fitment_extra" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "fitment_extra_connection_id_idx" ON "fitment_extra" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "rack_extra_shop_id_idx" ON "rack_extra" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "report_formulas_shop_id_idx" ON "report_formulas" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "schema_entities_shop_id_idx" ON "schema_entities" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "schema_fields_shop_id_idx" ON "schema_fields" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "setup_tokens_shop_id_idx" ON "setup_tokens" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "users_shop_id_idx" ON "users" USING btree ("shop_id");