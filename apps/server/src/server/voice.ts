import { MAX_CHUNK_BYTES, MAX_TURN_MS, VOICE_SAMPLE_RATE } from "@dokaanbondhu/contracts";
import { appError } from "./errors";
import type { Caller } from "./route";

// Voice chunks in memory (spec 8.4): kept by turn ID, tied to the user and shop of the first chunk (anyone else's
// chunk or finish is TURN_NOT_FOUND), at most 30.5 s of audio, dropped 60 s after the last chunk. One store per
// process on globalThis, so the chunk route and the finish route share it.

const MAX_TURN_BYTES = (MAX_TURN_MS / 1000) * VOICE_SAMPLE_RATE * 2;
const DROP_AFTER_MS = 60_000;
const WAIT_FOR_MISSING_MS = 1_000;

interface VoiceTurn {
  userId: string;
  shopId: string;
  conversationId: string;
  chunks: Map<number, Uint8Array>;
  bytes: number;
  lastAt: number;
  /** Called when a chunk arrives, so a waiting finish can look again. */
  arrived: (() => void)[];
}

const holder = globalThis as { __dokaanVoiceTurns?: Map<string, VoiceTurn> };
const turns = (holder.__dokaanVoiceTurns ??= new Map());

function sweep(now: number): void {
  for (const [id, turn] of turns) if (now - turn.lastAt > DROP_AFTER_MS) turns.delete(id);
}

function owned(turn: VoiceTurn, caller: Caller, conversationId: string): boolean {
  return (
    turn.userId === caller.userId && turn.shopId === caller.shopId && turn.conversationId === conversationId
  );
}

/** Keeps one chunk (the same seq twice keeps the last one, so a resent chunk is harmless). */
export function addChunk(
  caller: Caller,
  turnId: string,
  conversationId: string,
  seq: number,
  bytes: Uint8Array,
  now = Date.now(),
): void {
  sweep(now);
  if (bytes.byteLength > MAX_CHUNK_BYTES) throw appError("CHUNK_TOO_LARGE", 413);
  let turn = turns.get(turnId);
  if (turn && !owned(turn, caller, conversationId)) throw appError("TURN_NOT_FOUND", 404);
  if (!turn) {
    turn = {
      userId: caller.userId,
      shopId: caller.shopId,
      conversationId,
      chunks: new Map(),
      bytes: 0,
      lastAt: now,
      arrived: [],
    };
    turns.set(turnId, turn);
  }
  const before = turn.chunks.get(seq)?.byteLength ?? 0;
  if (turn.bytes - before + bytes.byteLength > MAX_TURN_BYTES) throw appError("TURN_TOO_LONG", 413);
  turn.chunks.set(seq, bytes);
  turn.bytes += bytes.byteLength - before;
  turn.lastAt = now;
  for (const wake of turn.arrived.splice(0)) wake();
}

const missingOf = (turn: VoiceTurn | undefined, count: number) =>
  Array.from({ length: count }, (_, seq) => seq).filter((seq) => !turn?.chunks.has(seq));

/**
 * The whole clip of a finished turn, chunks joined in seq order; the turn is then forgotten. Missing chunks are
 * waited for up to 1 s, then CHUNKS_MISSING with details.missing, so the phone resends them and finishes again.
 */
export async function takeClip(
  caller: Caller,
  turnId: string,
  conversationId: string,
  chunkCount: number,
): Promise<Uint8Array> {
  const deadline = Date.now() + WAIT_FOR_MISSING_MS;
  for (;;) {
    const turn = turns.get(turnId);
    if (turn && !owned(turn, caller, conversationId)) throw appError("TURN_NOT_FOUND", 404);
    const missing = missingOf(turn, chunkCount);
    if (turn && missing.length === 0) {
      turns.delete(turnId);
      const clip = new Uint8Array(turn.bytes);
      let at = 0;
      for (let seq = 0; seq < chunkCount; seq++) {
        const chunk = turn.chunks.get(seq)!;
        clip.set(chunk, at);
        at += chunk.byteLength;
      }
      return clip.slice(0, at);
    }
    const left = deadline - Date.now();
    if (left <= 0) throw appError("CHUNKS_MISSING", 409, { missing });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(left, 100));
      turn?.arrived.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Test helper: forget every turn. */
export function clearVoiceTurns(): void {
  turns.clear();
}
