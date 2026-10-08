import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ErrorCode, ReplyEvent } from "@dokaanbondhu/contracts";
import { ASK_AGAIN, pcmDurationMs, pcmToWav, trimSilence } from "@dokaanbondhu/core";
import {
  buildKeyterms,
  CONFIRM_TTL_MS,
  runTurn,
  type ConversationState,
  type Offer,
  type RequestFrame,
  type SessionContext,
  type TurnInput,
  type TurnState,
} from "@dokaanbondhu/engine/conversation";
import { HostConnectionError, ReadQueryRejected, SchemaMapError } from "@dokaanbondhu/engine/host";
import { SpeechError, type AsrResult } from "@dokaanbondhu/engine/providers";
import type { ActionPreview, ActionRecord, HostCall, PendingAction } from "@dokaanbondhu/engine/write";
import {
  actionLogs,
  aliasSuggestions,
  conversations,
  messages,
  requestFrames,
  users,
  type Tx,
} from "@dokaanbondhu/platform-db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { serverEnv } from "../env";
import { appError } from "./errors";
import { shopHost } from "./host";
import type { Caller } from "./route";
import { loadShop, settingsOf, shopLlm, shopSpeech } from "./shop";
import { Speaker } from "./speak";
import { logger, platform } from "./singletons";

// Chat and voice turns on the server (spec 8.3, 8.4, 8.5, 9.1): load the conversation, its open frame and the last
// messages; for voice, trim and transcribe the clip first; run the engine's turn; save both messages, the state, the
// context and the frame; stream every event as one NDJSON line, speaking the sentences when asked. The done event is
// held back until the turn is saved and spoken, so the app's next message always sees this one.

const HISTORY = 6;

type FrameRow = typeof requestFrames.$inferSelect;
type ActionRow = typeof actionLogs.$inferSelect;

/** The action waiting for yes or no; it expires 60 s after it was made (spec 9.9). */
function pendingOf(row: ActionRow): PendingAction {
  return {
    id: row.id,
    capabilityId: row.capabilityId,
    request: row.request as HostCall,
    preview: row.preview as ActionPreview,
    idempotencyKey: row.idempotencyKey,
    expiresAt: new Date(row.createdAt.getTime() + CONFIRM_TTL_MS).toISOString(),
  };
}

/** Saves the turn's changes to action_logs: a new pending action, or the decision on one (spec 9.9, 11.9 step 7). */
async function saveActions(
  tx: Tx,
  caller: Caller,
  conversationId: string,
  turnId: string,
  records: ActionRecord[],
) {
  for (const record of records) {
    if (record.status === "pending" && record.request && record.preview && record.idempotencyKey) {
      await tx.insert(actionLogs).values({
        id: record.id,
        shopId: caller.shopId,
        userId: caller.userId,
        conversationId,
        turnId,
        capabilityId: record.capabilityId,
        request: record.request,
        preview: record.preview,
        status: "pending",
        idempotencyKey: record.idempotencyKey,
      });
      continue;
    }
    await tx
      .update(actionLogs)
      .set({
        status: record.status,
        ...(record.response !== undefined ? { response: record.response } : {}),
        ...(record.verifyStatus ? { verifyStatus: record.verifyStatus } : {}),
        ...(record.confirmedAt ? { confirmedAt: new Date(record.confirmedAt) } : {}),
        ...(record.doneAt ? { doneAt: new Date(record.doneAt) } : {}),
      })
      .where(eq(actionLogs.id, record.id));
  }
}

function frameOf(row: FrameRow): RequestFrame {
  return {
    id: row.id,
    intent: row.intent,
    ...(row.capabilityId ? { capabilityId: row.capabilityId } : {}),
    slots: row.slots as RequestFrame["slots"],
    ...(row.asking ? { asking: row.asking } : {}),
    offers: row.offers as Offer[],
    ...(row.request ? { request: row.request } : {}),
    attempts: row.attempts as Record<string, number>,
    status: row.status as RequestFrame["status"],
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** True when the request carries the evaluation key (spec 18.4); compared in constant time. */
export function isEvalRequest(request: Request): boolean {
  const secret = serverEnv().EVAL_MODE_SECRET;
  const given = request.headers.get("x-eval-key");
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (event: ReplyEvent) =>
  `${JSON.stringify(event, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`;

/**
 * The reply stream (spec 8.5): one JSON object per line, flushed as soon as it exists. When the app goes away mid-turn,
 * the turn still finishes and is saved; its remaining events are dropped.
 */
export function ndjsonResponse(run: (emit: (event: ReplyEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ReplyEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(json(event)));
        } catch {
          open = false;
        }
      };
      try {
        await run(emit);
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export interface LoadedConversation {
  id: string;
  state: TurnState;
  frameId: string | null;
  /** The user's name: the acting user of a write (spec 11.9). */
  userName: string;
}

/** The caller's conversation with its open frame and last messages; someone else's is not found. */
export async function loadConversation(caller: Caller, conversationId: string): Promise<LoadedConversation> {
  return platform().withShop(caller.shopId, async (tx) => {
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, caller.userId)));
    if (!conversation) throw appError("CONVERSATION_NOT_FOUND", 404);
    const [open] = await tx
      .select()
      .from(requestFrames)
      .where(
        and(
          eq(requestFrames.conversationId, conversationId),
          inArray(requestFrames.status, ["active", "confirming"]),
        ),
      );
    // No open question: the latest finished request, so a short follow-up ("pechoner ta?") can change it (D95).
    const [latest] = open
      ? [open]
      : await tx
          .select()
          .from(requestFrames)
          .where(and(eq(requestFrames.conversationId, conversationId), eq(requestFrames.status, "done")))
          .orderBy(desc(requestFrames.updatedAt))
          .limit(1);
    const frame = latest;
    const [pending] = await tx
      .select()
      .from(actionLogs)
      .where(
        and(
          eq(actionLogs.conversationId, conversationId),
          eq(actionLogs.userId, caller.userId),
          eq(actionLogs.status, "pending"),
        ),
      )
      .orderBy(desc(actionLogs.createdAt))
      .limit(1);
    const [user] = await tx.select({ name: users.name }).from(users).where(eq(users.id, caller.userId));
    const last = await tx
      .select({ role: messages.role, text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY);
    return {
      id: conversation.id,
      frameId: frame?.id ?? null,
      userName: user?.name ?? "",
      state: {
        state: conversation.state as ConversationState,
        context: conversation.context as SessionContext,
        frame: frame ? frameOf(frame) : null,
        action: pending ? pendingOf(pending) : null,
        history: last.reverse().map((message) => ({
          role: message.role as "user" | "assistant",
          text: message.text ?? "",
        })),
      },
    };
  });
}

async function saveFrame(tx: Tx, shopId: string, conversationId: string, frame: RequestFrame): Promise<void> {
  const values = {
    intent: frame.intent,
    capabilityId: frame.capabilityId ?? null,
    slots: frame.slots,
    asking: frame.asking ?? null,
    offers: frame.offers ?? [],
    request: frame.request ?? null,
    attempts: frame.attempts,
    status: frame.status,
    expiresAt: new Date(frame.expiresAt),
    updatedAt: new Date(),
  };
  await tx
    .insert(requestFrames)
    .values({ id: frame.id, shopId, conversationId, ...values })
    .onConflictDoUpdate({ target: requestFrames.id, set: values });
}

function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof HostConnectionError || error instanceof SchemaMapError) return "HOST_ERROR";
  if (error instanceof ReadQueryRejected) return "HOST_ERROR";
  return "INTERNAL";
}

export interface TurnRequest {
  caller: Caller;
  conversation: LoadedConversation;
  text?: string;
  choice?: { slot: string; optionId: string };
  evalMode: boolean;
  requestId: string;
  /** Chat: the speaker toggle asks for audio too (D88). Voice turns always speak. */
  speak?: boolean;
}

/** What the turn saves as the user's message besides the engine's own facts. */
interface Said {
  userText: string | null;
  userMeta?: Record<string, unknown>;
  /** Stage timings measured before the engine ran (asr). */
  timings?: Record<string, number>;
}

type DoneEvent = Extract<ReplyEvent, { type: "done" }>;

/** The shop's voice for spoken replies (spec 7.2 settings). */
async function shopVoice(shopId: string): Promise<string> {
  const shop = await platform().withShop(shopId, (tx) => loadShop(tx, shopId));
  return settingsOf(shop).voice;
}

/**
 * Runs the engine's turn, saves it and streams it. Text events are also spoken when a speaker is given; the done event
 * waits until the turn is saved and every sentence has its audio, so the app's next message always sees this one.
 */
async function answer(
  request: TurnRequest,
  turnInput: TurnInput,
  said: Said,
  emit: (event: ReplyEvent) => void,
  speaker: Speaker | null,
): Promise<void> {
  const { caller, conversation } = request;
  let held: DoneEvent | null = null;
  const [llm, shopHostValue] = await Promise.all([shopLlm(caller.shopId), shopHost(caller.shopId)]);
  // Read before the turn, which changes the frame in place: when the open frame would have expired.
  const opened = conversation.state.frame;
  const openedExpiry = opened ? Date.parse(opened.expiresAt) : 0;
  const outcome = await runTurn(
    turnInput,
    conversation.state,
    {
      llm,
      dictionary: shopHostValue.dictionary,
      host: shopHostValue.host,
      now: () => new Date(),
      newId: () => randomUUID(),
      evalMode: request.evalMode,
      shopWords: shopHostValue.shopWords,
      role: caller.role,
      actingUser: conversation.userName,
    },
    (event) => {
      if (event.type === "done") {
        held = event;
        return;
      }
      emit(event);
      if (event.type === "text" && speaker) speaker.say(event.seq, event.text);
    },
  );
  const timings = { ...said.timings, ...outcome.meta.timings_ms };

  const now = new Date();
  await platform().withShop(caller.shopId, async (tx) => {
    await tx.insert(messages).values([
      {
        shopId: caller.shopId,
        conversationId: conversation.id,
        turnId: outcome.turnId,
        role: "user",
        text: said.userText,
        ...(said.userMeta ? { meta: said.userMeta } : {}),
      },
      {
        shopId: caller.shopId,
        conversationId: conversation.id,
        turnId: outcome.turnId,
        role: "assistant",
        text: outcome.assistantText,
        meta: { ...outcome.meta, timings_ms: timings },
        createdAt: sql`now() + interval '1 millisecond'`, // after the user's, for the history order
      },
    ]);
    await tx
      .update(conversations)
      .set({ state: outcome.state.state, context: outcome.state.context, lastActiveAt: now })
      .where(eq(conversations.id, conversation.id));
    // A new frame sets the old open one aside (or marks it expired); only one may be open (spec 9.3 rule 4).
    const next = outcome.state.frame;
    if (conversation.frameId && next?.id !== conversation.frameId) {
      await tx
        .update(requestFrames)
        .set({
          status: openedExpiry < now.getTime() ? "expired" : "set_aside",
          updatedAt: now,
        })
        .where(
          and(
            eq(requestFrames.id, conversation.frameId),
            inArray(requestFrames.status, ["active", "confirming"]),
          ),
        );
    }
    if (next) await saveFrame(tx, caller.shopId, conversation.id, next);
    await saveActions(tx, caller, conversation.id, outcome.turnId, outcome.actions);
    // Words learned from an answered question (D102 B): counted, and shown to the owner once seen twice.
    for (const word of outcome.learned) {
      await tx
        .insert(aliasSuggestions)
        .values({
          shopId: caller.shopId,
          heard: word.heard,
          targetConcept: word.concept,
          targetValue: word.value,
        })
        .onConflictDoUpdate({
          target: [
            aliasSuggestions.shopId,
            aliasSuggestions.heard,
            aliasSuggestions.targetConcept,
            aliasSuggestions.targetValue,
          ],
          set: { seen: sql`${aliasSuggestions.seen} + 1`, lastSeenAt: now },
        });
    }
  });
  if (speaker) await speaker.drain();
  const done = held as DoneEvent | null;
  if (done) {
    emit({
      ...done,
      timings_ms: {
        ...said.timings,
        ...done.timings_ms,
        ...(speaker?.firstAudioMs != null ? { first_audio: speaker.firstAudioMs } : {}),
      },
    });
  }
}

/** Streams the fatal error of a turn that failed after the stream started: an error event, then done. */
function failed(request: TurnRequest, error: unknown, emit: (event: ReplyEvent) => void, kind: string): void {
  const code = errorCodeOf(error);
  logger().error(
    { err: error, request_id: request.requestId, conversation_id: request.conversation.id },
    `${kind} turn failed`,
  );
  emit({ type: "error", code, message_key: `errors.${code}`, fatal: true });
  emit({ type: "done", turn_id: request.requestId, state: "IDLE", timings_ms: {} });
}

/** Runs one chat turn and streams it; failures after the stream started are an error event, then done. */
export async function chatTurn(request: TurnRequest, emit: (event: ReplyEvent) => void): Promise<void> {
  const startedAt = Date.now();
  try {
    // The chip's label is what the user "said"; read before the turn changes the frame.
    const tapped = request.choice
      ? request.conversation.state.frame?.offers?.find((offer) => offer.id === request.choice!.optionId)
          ?.label
      : undefined;
    let speaker: Speaker | null = null;
    if (request.speak) {
      const [speech, voice] = await Promise.all([
        shopSpeech(request.caller.shopId, request.evalMode),
        shopVoice(request.caller.shopId),
      ]);
      speaker = new Speaker(
        speech.tts,
        voice,
        emit,
        startedAt,
        { request_id: request.requestId },
        speech.speaks,
      );
    }
    await answer(
      request,
      {
        ...(request.text ? { text: request.text } : {}),
        ...(request.choice ? { choice: request.choice } : {}),
      },
      {
        userText: request.text ?? tapped ?? null,
        ...(request.choice ? { userMeta: { choice: request.choice } } : {}),
      },
      emit,
      speaker,
    );
  } catch (error) {
    failed(request, error, emit, "chat");
  }
}

export interface VoiceClip {
  /** The joined chunks: 16-bit little-endian mono PCM at 16 kHz. */
  pcm: Uint8Array;
  durationMs: number;
  rms: number;
}

const NBEST = 5;
const LOW_CONFIDENCE_BELOW = 0.5;
/** The speech worker's shortest clip (its MIN_CLIP_SECONDS), after the silence is cut. */
const MIN_CLIP_MS = 300;

/**
 * Runs one voice turn (spec 8.4, 9.1): trim the silence (D45), transcribe with the keyterms, then answer as a chat turn
 * with the N-best hypotheses, spoken. No speech, an empty or very quiet transcript, or a speech-to-text failure ends
 * the turn with "আবার বলবেন?" and no LLM call.
 */
export async function voiceTurn(
  request: TurnRequest,
  clip: VoiceClip,
  emit: (event: ReplyEvent) => void,
): Promise<void> {
  const startedAt = Date.now();
  const { caller, conversation } = request;
  try {
    // Turning the voice into words: "বুঝছি…"; "শুনছি…" is only the button while it is held (D115).
    emit({ type: "status", state: "UNDERSTANDING", label_key: "status.understanding" });
    const [speech, voice] = await Promise.all([
      shopSpeech(caller.shopId, request.evalMode),
      shopVoice(caller.shopId),
    ]);
    const speaker = new Speaker(
      speech.tts,
      voice,
      emit,
      startedAt,
      { request_id: request.requestId },
      speech.speaks,
    );
    const upload = { duration_ms: clip.durationMs, rms: clip.rms, bytes: clip.pcm.byteLength };
    const again = (voiceMeta: Record<string, unknown>, timings: Record<string, number>, heard?: string) =>
      askAgain(request, emit, speaker, startedAt, { upload, ...voiceMeta }, timings, heard ?? null);

    const trimmed = trimSilence(clip.pcm);
    if (!trimmed.speech) return await again({ reason: "no speech" }, {});
    // The speech worker refuses a clip under 0.3 s: asked again without calling it (D111).
    if (pcmDurationMs(trimmed.pcm) < MIN_CLIP_MS) return await again({ reason: "too short" }, {});
    if (!speech.stt) {
      emit({
        type: "error",
        code: "SPEECH_UNAVAILABLE",
        message_key: "errors.SPEECH_UNAVAILABLE",
        fatal: false,
      });
      return await again({ reason: "no speech-to-text provider" }, {});
    }
    const shopHostValue = await shopHost(caller.shopId);
    const keyterms = buildKeyterms(
      shopHostValue.host.catalog,
      shopHostValue.dictionary,
      conversation.state.context,
    );
    const asrStarted = Date.now();
    let result: AsrResult;
    try {
      result = await speech.stt.transcribe(pcmToWav(trimmed.pcm), {
        keyterms,
        nbest: NBEST,
        lowConfidenceBelow: LOW_CONFIDENCE_BELOW,
      });
    } catch (error) {
      // A clip the worker refused ("audio too short") is asked again; voice is not reported as not working (D111).
      const refused = error instanceof SpeechError && [400, 413, 422].includes(error.status ?? 0);
      logger().warn({ err: error, request_id: request.requestId }, "speech-to-text failed");
      if (!refused) {
        emit({
          type: "error",
          code: "SPEECH_UNAVAILABLE",
          message_key: "errors.SPEECH_UNAVAILABLE",
          fatal: false,
        });
      }
      return await again(
        { reason: refused ? "clip refused" : "speech-to-text failed" },
        { asr: Date.now() - asrStarted },
      );
    }
    const timings = { asr: Date.now() - asrStarted };
    const asr = {
      provider: speech.stt.id,
      duration_seconds: result.durationSeconds,
      processing_ms: result.processingMs,
      note: result.note,
      nbest: result.nbest.map((hypothesis) => hypothesis.text),
      keyterms: keyterms.length,
    };
    emit({
      type: "transcript",
      text: result.text,
      unclear: result.lowConfidenceWords.map((word) => word.word),
    });
    if (!result.text.trim() || result.note === "audio very quiet") {
      const reason = result.text.trim() ? "audio very quiet" : "empty transcript";
      return await again({ asr, reason }, timings, result.text || undefined);
    }
    await answer(
      request,
      { text: result.text, hypotheses: result.nbest.map((hypothesis) => hypothesis.text) },
      { userText: result.text, userMeta: { voice: { upload, asr } }, timings },
      emit,
      speaker,
    );
  } catch (error) {
    failed(request, error, emit, "voice");
  }
}

/** "আবার বলবেন?", spoken, without the LLM; the conversation keeps its state, so an open question stays open. */
async function askAgain(
  request: TurnRequest,
  emit: (event: ReplyEvent) => void,
  speaker: Speaker,
  startedAt: number,
  voice: Record<string, unknown>,
  timings: Record<string, number>,
  heard: string | null,
): Promise<void> {
  const { caller, conversation } = request;
  const turnId = randomUUID();
  emit({ type: "text", seq: 0, text: ASK_AGAIN, final: true });
  speaker.say(0, ASK_AGAIN);
  await platform().withShop(caller.shopId, (tx) =>
    tx.insert(messages).values([
      {
        shopId: caller.shopId,
        conversationId: conversation.id,
        turnId,
        role: "user",
        text: heard,
        meta: { voice },
      },
      {
        shopId: caller.shopId,
        conversationId: conversation.id,
        turnId,
        role: "assistant",
        text: ASK_AGAIN,
        meta: { timings_ms: { ...timings, total: Date.now() - startedAt }, llm_calls: 0 },
        createdAt: sql`now() + interval '1 millisecond'`,
      },
    ]),
  );
  await speaker.drain();
  emit({
    type: "done",
    turn_id: turnId,
    state: conversation.state.state,
    timings_ms: {
      ...timings,
      total: Date.now() - startedAt,
      ...(speaker.firstAudioMs != null ? { first_audio: speaker.firstAudioMs } : {}),
    },
  });
}
