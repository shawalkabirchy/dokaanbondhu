import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ErrorCode, ReplyEvent } from "@dokaanbondhu/contracts";
import { ASK_AGAIN, pcmToWav, trimSilence } from "@dokaanbondhu/core";
import {
  buildKeyterms,
  runTurn,
  type ConversationState,
  type Offer,
  type RequestFrame,
  type SessionContext,
  type TurnInput,
  type TurnState,
} from "@dokaanbondhu/engine/conversation";
import { HostConnectionError, ReadQueryRejected, SchemaMapError } from "@dokaanbondhu/engine/host";
import type { AsrResult } from "@dokaanbondhu/engine/providers";
import { conversations, messages, requestFrames, type Tx } from "@dokaanbondhu/platform-db";
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
    const last = await tx
      .select({ role: messages.role, text: messages.text })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY);
    return {
      id: conversation.id,
      frameId: frame?.id ?? null,
      state: {
        state: conversation.state as ConversationState,
        context: conversation.context as SessionContext,
        frame: frame ? frameOf(frame) : null,
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
      speaker = new Speaker(speech.tts, voice, emit, startedAt, { request_id: request.requestId });
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
    emit({ type: "status", state: "UNDERSTANDING", label_key: "status.listening" });
    const [speech, voice] = await Promise.all([
      shopSpeech(caller.shopId, request.evalMode),
      shopVoice(caller.shopId),
    ]);
    const speaker = new Speaker(speech.tts, voice, emit, startedAt, { request_id: request.requestId });
    const upload = { duration_ms: clip.durationMs, rms: clip.rms, bytes: clip.pcm.byteLength };
    const again = (voiceMeta: Record<string, unknown>, timings: Record<string, number>, heard?: string) =>
      askAgain(request, emit, speaker, startedAt, { upload, ...voiceMeta }, timings, heard ?? null);

    const trimmed = trimSilence(clip.pcm);
    if (!trimmed.speech) return await again({ reason: "no speech" }, {});
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
      logger().warn({ err: error, request_id: request.requestId }, "speech-to-text failed");
      emit({
        type: "error",
        code: "SPEECH_UNAVAILABLE",
        message_key: "errors.SPEECH_UNAVAILABLE",
        fatal: false,
      });
      return await again({ reason: "speech-to-text failed" }, { asr: Date.now() - asrStarted });
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
