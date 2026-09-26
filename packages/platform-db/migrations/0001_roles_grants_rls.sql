-- Roles, grants, row-level security and the pgboss schema (spec 7.3). Roles are created without a password:
-- migration files cannot read environment variables, so `npm run db:roles` sets the passwords.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_api') THEN
    CREATE ROLE platform_api LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin LOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- Exactly what the two roles need; row-level security still decides which rows.
GRANT USAGE ON SCHEMA public TO platform_api, platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_api, platform_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_api, platform_admin;

-- The same lockdown as GearGrid's: Supabase's automatic API gets nothing.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- What Drizzle cannot declare: the deferrable owner link (shops and users point at each other) and the one active
-- speech provider per job and shop, with the global rows (shop_id null) counted as one shop.
ALTER TABLE shops ADD CONSTRAINT shops_owner_user_id_users_id_fk
  FOREIGN KEY (owner_user_id) REFERENCES users (id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX ai_providers_one_active_speech_idx ON ai_providers (shop_id, job) NULLS NOT DISTINCT
  WHERE active AND job <> 'llm';

-- Every table: RLS enabled and forced, admin_all for platform_admin, shop_only for platform_api.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_all ON %I FOR ALL TO platform_admin USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY shop_only ON %I FOR ALL TO platform_api
         USING (%I = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (%I = nullif(current_setting(''app.shop_id'', true), '''')::uuid)',
      t, CASE WHEN t = 'shops' THEN 'id' ELSE 'shop_id' END, CASE WHEN t = 'shops' THEN 'id' ELSE 'shop_id' END);
  END LOOP;
END $$;

CREATE POLICY global_read ON aliases FOR SELECT TO platform_api USING (shop_id IS NULL);
CREATE POLICY global_read ON ai_providers FOR SELECT TO platform_api USING (shop_id IS NULL);
CREATE POLICY own_login ON users FOR SELECT TO platform_api
  USING (auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid);
-- The scanner upload carries a token instead of a login (withSetupToken): it may find and mark its own row.
CREATE POLICY token_lookup ON setup_tokens FOR SELECT TO platform_api
  USING (token_hash = nullif(current_setting('app.token_hash', true), ''));
CREATE POLICY token_use ON setup_tokens FOR UPDATE TO platform_api
  USING (token_hash = nullif(current_setting('app.token_hash', true), ''))
  WITH CHECK (token_hash = nullif(current_setting('app.token_hash', true), ''));

-- pg-boss creates only its tables here, at its first start (createSchema: false). AUTHORIZATION platform_api is
-- avoided: it needs the right to act as that role, which Supabase's postgres does not get on PostgreSQL 16+.
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO platform_api;
