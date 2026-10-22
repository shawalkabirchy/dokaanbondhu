import { z } from "zod";

// GET /reminders (spec 8.3, D194): parts running low and customers' old dues, counted, with the first few names, for
// the assistant page's card. A kind is null when the shop's app does not keep what it needs (no stock, no sales dues).

/** How many names the card shows. */
export const REMINDER_NAMES = 3;

const reminderCount = z.object({
  count: z.number().int().nonnegative(),
  /** More than the count were found; the list stops there. */
  more: z.boolean(),
  names: z.array(z.string()).max(REMINDER_NAMES),
});

export const remindersSchema = z.object({
  low_stock: reminderCount.nullable(),
  old_dues: reminderCount.extend({ old_taka: z.number().int().nonnegative() }).nullable(),
});
export type Reminders = z.infer<typeof remindersSchema>;
