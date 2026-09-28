import { readFileSync } from "node:fs";
import { z } from "zod";

// The test set (spec 18.4; architecture 11.2): one item per line of items.jsonl. Expected values refer to the shared
// seed data; `script` answers the questions an item should need, by slot.

const lookup = z.object({
  tool: z.literal("find_parts"),
  params: z.object({
    part_type: z.string().optional(),
    vehicle: z.string().optional(),
    year: z.number().optional(),
    position: z.string().optional(),
    quality: z.string().optional(),
    brand: z.string().optional(),
    part_number: z.string().optional(),
  }),
  part_key: z.string(),
  asks: z.string().optional(),
});

const read = z.object({
  read: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  answer: z.union([z.literal("see_in_app"), z.record(z.string(), z.unknown())]),
});

const write = z.object({
  action: z.string(),
  slots: z.record(z.string(), z.unknown()).optional(),
  part: z.record(z.string(), z.unknown()).optional(),
  part_key: z.string().optional(),
});

const mustNot = z.object({
  must_not: z.array(z.string()),
  part_key: z.string().optional(),
  vehicle: z.string().optional(),
  reason: z.string().optional(),
});

export const itemSchema = z.object({
  id: z.string(),
  channel: z.enum(["chat", "voice"]),
  split: z.enum(["open", "held_out"]),
  kind: z.enum(["part_lookup", "other_read", "write", "must_not_act"]),
  subkind: z.string().optional(),
  as: z.enum(["staff", "owner"]).default("staff"),
  text: z.string().optional(),
  audio: z.string().optional(),
  reference_transcript: z.string().optional(),
  task_card: z.string(),
  expected: z.union([lookup, write, mustNot, read]),
  script: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  needs_question: z.boolean().optional(),
});
export type Item = z.infer<typeof itemSchema>;
export type LookupExpected = z.infer<typeof lookup>;
export type ReadExpected = z.infer<typeof read>;
export type WriteExpected = z.infer<typeof write>;
export type MustNotExpected = z.infer<typeof mustNot>;

export function loadItems(path: string): Item[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      const parsed = itemSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`items.jsonl line ${index + 1}: ${parsed.error.message}`);
      return parsed.data;
    });
}
