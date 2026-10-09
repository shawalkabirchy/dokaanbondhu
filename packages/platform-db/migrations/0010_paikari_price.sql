ALTER TABLE "connections" ADD COLUMN "paikari_price" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_paikari_price_check" CHECK ("connections"."paikari_price" in ('garage_price', 'wholesale_price'));--> statement-breakpoint
-- A price level the owner chose as garage or wholesale is paikari now, the one trade price (D145).
UPDATE "connections" SET "app_words" = jsonb_set("app_words", '{price_tier}', (SELECT coalesce(jsonb_object_agg("key", CASE WHEN "value" #>> '{}' IN ('garage', 'wholesale') THEN '"paikari"'::jsonb ELSE "value" END), '{}'::jsonb) FROM jsonb_each("app_words" -> 'price_tier'))) WHERE jsonb_typeof("app_words" -> 'price_tier') = 'object';
