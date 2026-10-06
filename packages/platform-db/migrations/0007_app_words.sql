ALTER TABLE "connections" ADD COLUMN "app_words" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- The price levels the owner chose (D121) move into app_words with the other app words (D122).
UPDATE "connections" SET "app_words" = jsonb_build_object('price_tier', "price_tiers") WHERE "price_tiers" <> '{}'::jsonb;
