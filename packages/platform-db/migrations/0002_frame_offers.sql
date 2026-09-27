ALTER TABLE "request_frames" ADD COLUMN "offers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "request_frames" ADD COLUMN "request" text;