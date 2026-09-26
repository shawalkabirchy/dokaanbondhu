import pg from "pg";
import { z } from "zod";

// npm run db:roles (spec 7.3): sets the passwords of platform_api and platform_admin. Migration files cannot read
// environment variables, so the custom migration creates the roles without a password and this step sets them.

export async function setRolePasswords(
  client: pg.ClientBase,
  passwords: { platformApi: string; platformAdmin: string },
): Promise<void> {
  const roles: [string, string][] = [
    ["platform_api", passwords.platformApi],
    ["platform_admin", passwords.platformAdmin],
  ];
  for (const [role, password] of roles) {
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
  }
}

const env = z
  .object({
    PLATFORM_MIGRATION_DATABASE_URL: z.string().min(1),
    PLATFORM_API_PASSWORD: z.string().min(8),
    PLATFORM_ADMIN_PASSWORD: z.string().min(8),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(
    `Missing or invalid variables: ${env.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
  );
  process.exit(1);
}
const client = new pg.Client({ connectionString: env.data.PLATFORM_MIGRATION_DATABASE_URL });
await client.connect();
try {
  await setRolePasswords(client, {
    platformApi: env.data.PLATFORM_API_PASSWORD,
    platformAdmin: env.data.PLATFORM_ADMIN_PASSWORD,
  });
  process.stdout.write("db:roles: passwords set for platform_api and platform_admin\n");
} finally {
  await client.end();
}
