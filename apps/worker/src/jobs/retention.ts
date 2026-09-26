import type { Platform } from "@dokaanbondhu/platform-db";
import { sql } from "drizzle-orm";

// retention.nightly (spec 7.4): 02:00 Asia/Dhaka. Deletes messages older than 90 days and closed request frames
// older than 1 day, in every shop (so it runs as platform_admin). N-best lists exist only for consenting shops (D41).

export async function runRetention(
  admin: Platform,
  now = new Date(),
): Promise<{ messages: number; frames: number }> {
  return admin.withAdmin(async (tx) => {
    const messages = await tx.execute(
      sql`delete from messages where created_at < ${now.toISOString()}::timestamptz - interval '90 days'`,
    );
    const frames = await tx.execute(
      sql`delete from request_frames
          where status in ('done', 'cancelled', 'expired')
            and updated_at < ${now.toISOString()}::timestamptz - interval '1 day'`,
    );
    return { messages: messages.rowCount ?? 0, frames: frames.rowCount ?? 0 };
  });
}
