import { existsSync, readFileSync } from "node:fs";
import { ASK_AGAIN } from "@dokaanbondhu/core";
import { z } from "zod";

// The test shop's kept voice clips, replayed (D149): the server keeps a consenting shop's clips at
// <shop_id>/live/<date>/<conversation_id>/<turn_id>.wav; each conversation's clips are sent again in the order they
// were said, in a new conversation, through the server as it is now. What was heard and answered is compared with
// clip-labels.jsonl: what the owner meant, words the answer must contain and words it must not. A "yes" to a
// confirmation is not sent again, so a replay never saves anything a second time.

export const clipLabelSchema = z.object({
  clip: z.string(),
  /** What the owner said, as it should have been written. */
  meant: z.string(),
  /** Words the answer must contain: a name, a car with its year, a quantity ("২ সেট"). */
  expect: z.array(z.string()).default([]),
  /** Words the answer must not contain: a wrong car or year once given for this clip ("হ্যারিয়ার", "২০০০"). */
  avoid: z.array(z.string()).default([]),
  /** The clip holds no speech (the microphone gave silence, or under 0.2 s reached the server): asking again is right. */
  no_speech: z.boolean().default(false),
  /** A yes to a confirmation: not sent in a replay, so nothing is saved twice. */
  confirms: z.boolean().default(false),
  /** Why the label is as it is, when the replay cannot repeat what happened (a tap is not replayed). */
  note: z.string().optional(),
});
export type ClipLabel = z.infer<typeof clipLabelSchema>;

export function loadClipLabels(file: string): Map<string, ClipLabel> {
  if (!existsSync(file)) return new Map();
  const labels = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => clipLabelSchema.parse(JSON.parse(line)));
  return new Map(labels.map((label) => [label.clip, label]));
}

export interface ClipResult {
  clip: string;
  heard: string | null;
  reply: string;
  askedAgain: boolean;
  /** Labelled as holding no speech. */
  noSpeech?: boolean;
  /** Labelled clips only: the expected words the answer lacked, and the avoided words it held. */
  missing?: string[];
  unwanted?: string[];
  passed?: boolean;
}

/**
 * A replayed clip against its label: passed when it was not asked again, the answer holds every expected word and none
 * of the avoided ones; a clip without speech passes only when it was asked again.
 */
export function scoreClip(
  clip: string,
  turn: { transcript?: string; reply: string },
  label: ClipLabel | undefined,
): ClipResult {
  const askedAgain = turn.reply.trim() === ASK_AGAIN;
  const result: ClipResult = { clip, heard: turn.transcript ?? null, reply: turn.reply, askedAgain };
  if (!label) return result;
  if (label.no_speech) return { ...result, noSpeech: true, missing: [], unwanted: [], passed: askedAgain };
  const missing = label.expect.filter((word) => !turn.reply.includes(word));
  const unwanted = label.avoid.filter((word) => turn.reply.includes(word));
  return { ...result, missing, unwanted, passed: !askedAgain && !missing.length && !unwanted.length };
}

export interface ClipSummary {
  clips: number;
  /** Asked again although the clip held speech (a labelled clip without speech is not counted). */
  askedAgain: number;
  labelled: number;
  passed: number;
}

export function summarize(results: ClipResult[]): ClipSummary {
  const labelled = results.filter((result) => result.passed !== undefined);
  return {
    clips: results.length,
    askedAgain: results.filter((result) => result.askedAgain && !result.noSpeech).length,
    labelled: labelled.length,
    passed: labelled.filter((result) => result.passed).length,
  };
}

/** Storage as the replay needs it: folder listings (oldest first) and downloads. */
export interface ClipStorage {
  list(path: string): Promise<{ name: string; createdAt: string | null; folder: boolean }[]>;
  download(path: string): Promise<Uint8Array>;
}

/** Every kept conversation from the given date on, each with its clips in the order they were said. */
export async function keptConversations(
  storage: ClipStorage,
  shopId: string,
  since: string | null,
): Promise<{ conversation: string; clips: string[] }[]> {
  const root = `${shopId}/live`;
  const dates = (await storage.list(root))
    .filter((entry) => entry.folder && (!since || entry.name >= since))
    .map((entry) => entry.name)
    .sort();
  const out: { conversation: string; clips: string[] }[] = [];
  for (const date of dates) {
    const conversations = (await storage.list(`${root}/${date}`)).filter((entry) => entry.folder);
    const withClips = await Promise.all(
      conversations.map(async (conversation) => {
        const path = `${root}/${date}/${conversation.name}`;
        const files = (await storage.list(path))
          .filter((entry) => !entry.folder && entry.name.endsWith(".wav"))
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        return {
          conversation: conversation.name,
          clips: files.map((file) => `${path}/${file.name}`),
          first: files[0]?.createdAt ?? "",
        };
      }),
    );
    for (const { conversation, clips } of withClips.sort((a, b) => a.first.localeCompare(b.first)))
      if (clips.length) out.push({ conversation, clips });
  }
  return out;
}
