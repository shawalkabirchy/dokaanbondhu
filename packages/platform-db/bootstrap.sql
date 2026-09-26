-- CI only (spec 7.3; the same content as GearGrid's supabase/bootstrap.sql): recreates what a Supabase project
-- already has, so the lockdown tests mean something. Each role is created only if missing, because the two apps'
-- CI shares one container.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- Supabase's default, which the first custom migration revokes.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
