import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "../env";
import { appError } from "./errors";

// Creating staff logins through the Supabase admin API (spec 8.3, D9, D42). Tests replace it with a fake, because
// CI has no Supabase project.

export interface AuthAdmin {
  createUser(input: { email: string; password: string; name: string }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
}

function supabaseAuthAdmin(): AuthAdmin {
  const env = serverEnv();
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async createUser({ email, password, name }) {
      const { data, error } = await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
      });
      if (error || !data.user) {
        if (error?.code === "email_exists" || error?.status === 422) {
          throw appError("VALIDATION_FAILED", 400, { field: "email", reason: "taken" });
        }
        throw new Error(`Supabase admin createUser failed: ${error?.message ?? "no user"}`);
      }
      return { id: data.user.id };
    },
    async deleteUser(id) {
      const { error } = await client.auth.admin.deleteUser(id);
      if (error) throw new Error(`Supabase admin deleteUser failed: ${error.message}`);
    },
  };
}

const holder = globalThis as { __dokaanAuthAdmin?: AuthAdmin };

export const authAdmin = (): AuthAdmin => (holder.__dokaanAuthAdmin ??= supabaseAuthAdmin());

/** Tests only. */
export function setAuthAdminForTests(fake: AuthAdmin | undefined): void {
  holder.__dokaanAuthAdmin = fake;
}
