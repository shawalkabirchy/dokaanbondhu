import { randomInt, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { encryptSecret, parseAesKey } from "@dokaanbondhu/engine/crypto";
import { aiProviders, createPlatform, shops, users, type Platform } from "@dokaanbondhu/platform-db";
import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

// npm run admin -- <command> (spec 7.5): shops, owners, consent and AI providers, as platform_admin. On the laptop
// it works on dokaan-dev; for dokaan-prod (step 9) it runs in the pod's terminal. Staff logins are made by the
// owner in the app (D9), not here. sync-catalog comes in step 3 and import-verification in step 5.

const out = (line: string) => process.stdout.write(`${line}\n`);

const env = z
  .object({
    PLATFORM_ADMIN_DATABASE_URL: z.string().min(1),
    SUPABASE_URL: z.url(),
    SUPABASE_SECRET_KEY: z.string().min(20),
    AES_KEY: z.string().min(40),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(
    `Missing or invalid variables: ${env.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  );
  process.exit(1);
}

const uuid = z.uuid();
const bool = z.enum(["true", "false"]).transform((value) => value === "true");
const providerOptions = z
  .object({
    auth: z.enum(["modal", "x-api-key"]).optional(),
    extra_body: z.record(z.string(), z.unknown()).optional(),
    voice_ids: z.record(z.string(), z.string()).optional(),
  })
  .strict();

function password(length = 16): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function supabaseAdmin() {
  if (!env.success) throw new Error("unreachable");
  return createClient(env.data.SUPABASE_URL, env.data.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

type Command = (platform: Platform, args: string[]) => Promise<void>;

const commands: Record<string, Command> = {
  /** create-shop --name <n> [--market <m>] [--allow-external] */
  "create-shop": async (platform, args) => {
    const { values } = parseArgs({
      args,
      options: {
        name: { type: "string" },
        market: { type: "string" },
        "allow-external": { type: "boolean" },
      },
    });
    const name = z.string().min(1).parse(values.name);
    const settings = values["allow-external"] ? { external_providers_allowed: true } : {};
    const [shop] = await platform.withAdmin((tx) =>
      tx
        .insert(shops)
        .values({ name, marketArea: values.market ?? null, settings })
        .returning(),
    );
    out(`Shop created: ${shop?.id}  ${name}`);
  },

  /** create-owner --shop <id> --email <e> --name <n>: the Supabase login (email confirmed) and the users row. */
  "create-owner": async (platform, args) => {
    const { values } = parseArgs({
      args,
      options: { shop: { type: "string" }, email: { type: "string" }, name: { type: "string" } },
    });
    const shopId = uuid.parse(values.shop);
    const email = z.email().parse(values.email);
    const name = z.string().min(1).parse(values.name);
    const oneTimePassword = password();
    const admin = supabaseAdmin();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: oneTimePassword,
      email_confirm: true,
      user_metadata: { name },
    });
    if (error || !data.user)
      throw new Error(`Supabase could not create the login: ${error?.message ?? "no user"}`);
    const authUserId = data.user.id;
    try {
      await platform.withAdmin(async (tx) => {
        const [shop] = await tx.select().from(shops).where(eq(shops.id, shopId));
        if (!shop) throw new Error(`no shop ${shopId}`);
        const [user] = await tx
          .insert(users)
          .values({ shopId, authUserId, name, email, role: "owner" })
          .returning();
        await tx.update(shops).set({ ownerUserId: user?.id }).where(eq(shops.id, shopId));
      });
    } catch (failure) {
      await admin.auth.admin.deleteUser(authUserId); // no half-made owner
      throw failure;
    }
    out(`Owner created: ${email} for shop ${shopId}`);
    out(`One-time password: ${oneTimePassword}`);
  },

  /** set-consent --shop <id> --evaluation true|false (after the shop's written consent, D41) */
  "set-consent": async (platform, args) => {
    const { values } = parseArgs({
      args,
      options: { shop: { type: "string" }, evaluation: { type: "string" } },
    });
    const shopId = uuid.parse(values.shop);
    const evaluation = bool.parse(values.evaluation);
    const updated = await platform.withAdmin((tx) =>
      tx
        .update(shops)
        .set({
          settings: sql`${shops.settings} || jsonb_build_object('evaluation_consent', ${evaluation}::boolean)`,
        })
        .where(eq(shops.id, shopId))
        .returning({ id: shops.id }),
    );
    if (updated.length === 0) throw new Error(`no shop ${shopId}`);
    out(`Evaluation consent for shop ${shopId}: ${evaluation}`);
  },

  /**
   * set-provider --job llm|stt|tts [--shop <id>] --provider <p> --model <m> --base-url <u> --secret-env <VAR>
   *   [--priority <n> | --active] --external true|false [--options <json>]
   * Reads the secret from the named variable, encrypts it and never echoes it. Without --shop: a global row. A row
   * with the same shop, job and provider is updated instead of added again.
   */
  "set-provider": async (platform, args) => {
    const { values } = parseArgs({
      args,
      options: {
        job: { type: "string" },
        shop: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        "secret-env": { type: "string" },
        priority: { type: "string" },
        active: { type: "boolean" },
        external: { type: "string" },
        options: { type: "string" },
      },
    });
    const job = z.enum(["llm", "stt", "tts"]).parse(values.job);
    const shopId = values.shop === undefined ? null : uuid.parse(values.shop);
    const provider = z
      .enum(["vllm", "cloudflare", "deepseek", "openai", "openrouter", "speech_worker", "elevenlabs"])
      .parse(values.provider);
    const external = bool.parse(values.external);
    const options = providerOptions.parse(values.options === undefined ? {} : JSON.parse(values.options));
    const priority = values.priority === undefined ? null : z.coerce.number().int().parse(values.priority);
    if (job === "llm" && values.active)
      throw new Error("--active is for speech jobs; an LLM row takes --priority");
    const secretName = values["secret-env"];
    const secret = secretName === undefined ? undefined : process.env[secretName];
    if (secretName !== undefined && !secret) throw new Error(`the variable ${secretName} is empty`);
    if (!env.success) throw new Error("unreachable");
    const key = parseAesKey(env.data.AES_KEY);

    const id = await platform.withAdmin(async (tx) => {
      const sameShop = shopId === null ? isNull(aiProviders.shopId) : eq(aiProviders.shopId, shopId);
      const [existing] = await tx
        .select({ id: aiProviders.id })
        .from(aiProviders)
        .where(and(sameShop, eq(aiProviders.job, job), eq(aiProviders.provider, provider)));
      const rowId = existing?.id ?? randomUUID(); // made before the insert: it is part of the encryption (spec 13.5)
      const secretEncrypted =
        secret === undefined
          ? null
          : encryptSecret(key, { table: "ai_providers", rowId, column: "secret_encrypted" }, secret);
      if (values.active) {
        await tx
          .update(aiProviders)
          .set({ active: false })
          .where(and(sameShop, eq(aiProviders.job, job)));
      }
      const fields = {
        model: values.model ?? null,
        baseUrl: values["base-url"] ?? null,
        secretEncrypted,
        options,
        priority,
        active: values.active ?? false,
        external,
        enabled: true,
      };
      if (existing) await tx.update(aiProviders).set(fields).where(eq(aiProviders.id, rowId));
      else await tx.insert(aiProviders).values({ id: rowId, shopId, job, provider, ...fields });
      return rowId;
    });
    out(`Provider ${provider} (${job}, ${shopId ?? "global"}): ${id}`);
  },

  /** list-shops */
  "list-shops": async (platform) => {
    const rows = await platform.withAdmin((tx) =>
      tx
        .select({ id: shops.id, name: shops.name, settings: shops.settings, owner: users.email })
        .from(shops)
        .leftJoin(users, eq(users.id, shops.ownerUserId)),
    );
    if (rows.length === 0) out("No shops yet.");
    for (const row of rows)
      out(`${row.id}  ${row.name}  owner: ${row.owner ?? "-"}  settings: ${JSON.stringify(row.settings)}`);
  },

  /** disable-user --user <id> */
  "disable-user": async (platform, args) => {
    const { values } = parseArgs({ args, options: { user: { type: "string" } } });
    const userId = uuid.parse(values.user);
    const updated = await platform.withAdmin((tx) =>
      tx
        .update(users)
        .set({ status: "disabled", updatedAt: sql`now()` })
        .where(eq(users.id, userId))
        .returning({ email: users.email }),
    );
    if (updated.length === 0) throw new Error(`no user ${userId}`);
    out(`Disabled: ${updated[0]?.email}`);
  },
};

const [name, ...rest] = process.argv.slice(2);
const command = name ? commands[name] : undefined;
if (!command) {
  console.error(`Usage: npm run admin -- <${Object.keys(commands).join(" | ")}> [options]`);
  process.exit(1);
}
const platform = createPlatform(env.data.PLATFORM_ADMIN_DATABASE_URL, { max: 1 });
try {
  await command(platform, rest);
} catch (error) {
  console.error(
    error instanceof z.ZodError ? `Invalid option: ${error.issues[0]?.message}` : (error as Error).message,
  );
  process.exitCode = 1;
} finally {
  await platform.end();
}
