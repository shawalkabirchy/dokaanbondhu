import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Item } from "./items";

// The speakers' recordings on the laptop (spec D235): one folder per speaker (S1 to S5), each file named by its card
// code. Phones write the code their own way (V-005, v106, v_042), so a name is read loosely; a file is used only when it
// is a voice card on that speaker's own sheet.

export const AUDIO_EXTENSIONS = new Set([
  ".m4a",
  ".mp3",
  ".wav",
  ".aac",
  ".ogg",
  ".opus",
  ".amr",
  ".3gp",
  ".flac",
  ".webm",
  ".caf",
]);

/** The card code a recording's file name gives ("V-005.m4a", "v106.mp3", "v_042 .wav" → v-005, v-106, v-042). */
export function cardOfFile(name: string): string | null {
  const stem = basename(name, extname(name)).trim().toLowerCase();
  const match = stem.match(/^v[\s_-]*0*(\d{1,3})$/);
  return match ? `v-${match[1]!.padStart(3, "0")}` : null;
}

export interface LocalClips {
  /** Card code → the recording's path. */
  found: Map<string, string>;
  /** Files that could not be used, and cards of a speaker with a folder but no file, in plain words. */
  problems: string[];
}

/** The recordings under `dir` (one folder per speaker), checked against the voice cards. */
export function localClips(dir: string, items: Item[]): LocalClips {
  const voice = new Map(items.filter((item) => item.channel === "voice").map((item) => [item.id, item]));
  const found = new Map<string, string>();
  const problems: string[] = [];
  const speakers = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
  for (const speaker of speakers) {
    const files = readdirSync(join(dir, speaker))
      .filter((name) => AUDIO_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort();
    for (const file of files) {
      const id = cardOfFile(file);
      const item = id ? voice.get(id) : undefined;
      if (!id || !item) problems.push(`${speaker}/${file}: not a voice card's code`);
      else if (item.speaker !== speaker) problems.push(`${speaker}/${file}: ${id} is ${item.speaker}'s card`);
      else if (found.has(id)) problems.push(`${speaker}/${file}: a second file for ${id}`);
      else found.set(id, join(dir, speaker, file));
    }
    if (files.length) {
      for (const item of voice.values())
        if (item.speaker === speaker && !found.has(item.id))
          problems.push(`${speaker}: no file for ${item.id}`);
    }
  }
  return { found, problems };
}

/**
 * items.jsonl with one item's reference transcript set, every other byte unchanged: only that line's
 * `reference_transcript` value is replaced, so the file keeps its own spacing and order.
 */
export function withTranscript(file: string, id: string, transcript: string): string {
  const text = transcript.normalize("NFC").replace(/\s+/g, " ").trim();
  const lines = file.split("\n");
  const index = lines.findIndex((line) => {
    if (!line.trim()) return false;
    return (JSON.parse(line) as { id?: string }).id === id;
  });
  if (index < 0) throw new Error(`no item ${id}`);
  const line = lines[index]!;
  const field = /("reference_transcript"\s*:\s*)"(?:[^"\\]|\\.)*"/;
  const next = field.test(line)
    ? line.replace(field, (_, key: string) => `${key}${JSON.stringify(text)}`)
    : line.replace(/\}\s*$/, `, "reference_transcript": ${JSON.stringify(text)}}`);
  const parsed = JSON.parse(next) as { id?: string; reference_transcript?: string };
  if (parsed.id !== id || parsed.reference_transcript !== text)
    throw new Error(`could not set ${id}'s transcript`);
  lines[index] = next;
  return lines.join("\n");
}
