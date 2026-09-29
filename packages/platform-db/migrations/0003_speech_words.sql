CREATE TABLE "alias_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"heard" text NOT NULL,
	"target_concept" text NOT NULL,
	"target_value" text NOT NULL,
	"seen" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alias_suggestions_target_concept_check" CHECK ("alias_suggestions"."target_concept" in ('part_type', 'vehicle_model', 'quality', 'position', 'unit', 'brand')),
	CONSTRAINT "alias_suggestions_status_check" CHECK ("alias_suggestions"."status" in ('open', 'added', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "speech_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"target_concept" text NOT NULL,
	"target_value" text NOT NULL,
	"spoken" text NOT NULL,
	"heard" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speech_checks_target_concept_check" CHECK ("speech_checks"."target_concept" in ('part_type', 'vehicle_model', 'quality', 'position', 'unit', 'brand'))
);
--> statement-breakpoint
ALTER TABLE "aliases" DROP CONSTRAINT "aliases_source_check";--> statement-breakpoint
ALTER TABLE "alias_suggestions" ADD CONSTRAINT "alias_suggestions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_checks" ADD CONSTRAINT "speech_checks_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alias_suggestions_unique" ON "alias_suggestions" USING btree ("shop_id","heard","target_concept","target_value");--> statement-breakpoint
CREATE UNIQUE INDEX "speech_checks_unique" ON "speech_checks" USING btree ("shop_id","target_concept","target_value");--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_source_check" CHECK ("aliases"."source" in ('global', 'owner', 'host', 'asr_check', 'learned'));--> statement-breakpoint
-- The same row-level security as every other table (0001): forced, admin_all for platform_admin, shop_only for
-- platform_api. The grants come from the default privileges of 0001.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['alias_suggestions', 'speech_checks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_all ON %I FOR ALL TO platform_admin USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY shop_only ON %I FOR ALL TO platform_api
         USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
