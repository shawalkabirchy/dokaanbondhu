import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ErrorCode, ReplyEvent } from "@dokaanbondhu/contracts";
import {
  runTurn,
  type ConversationState,
  type Offer,
  type RequestFrame,
  type SessionContext,
  type TurnInput,
  type TurnState,
} from "@dokaanbondhu/engine/conversation";
import { HostConnectionError, ReadQueryRejected, SchemaMapError } from "@dokaanbondhu/engine/host";
import { conversations, messages, requestFrames, type Tx } from "@dokaanbondhu/platform-db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { serverEnv } from "../env";
import { appError } from "./errors";
import { shopHost } from "./host";
import type { Caller } from "./route";
import { shopLlm } from "./shop";
import { logger, platform } from "./singletons";

// A chat turn on the server (spec 8.3, 8.5, 9.1): load the conversation, its open frame and the last messages; run
// the engine's turn; save both messages, the state, the context and the frame; stream every event as one NDJSON line.
// The done event is held back until the turn is saved, so the app's next message always sees this one.

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

export interface ChatTurnInput {
  caller: Caller;
  conversation: LoadedConversation;
  text?: string;
  choice?: { slot: string; optionId: string };
  evalMode: boolean;
  requestId: string;
}

/** Runs one chat turn and streams it; failures after the stream started are an error event, then done. */
export async function chatTurn(input: ChatTurnInput, emit: (event: ReplyEvent) => void): Promise<void> {
  const { caller, conversation } = input;
  let held: ReplyEvent | null = null;
  try {
    const [llm, shopHostValue] = await Promise.all([shopLlm(caller.shopId), shopHost(caller.shopId)]);
    // Read before the turn, which changes the frame in place: the chip's label (what the user "said") and when the
    // open frame would have expired.
    const opened = conversation.state.frame;
    const tapped = input.choice
      ? opened?.offers?.find((offer) => offer.id === input.choice!.optionId)?.label
      : undefined;
    const openedExpiry = opened ? Date.parse(opened.expiresAt) : 0;
    const turnInput: TurnInput = {
      ...(input.text ? { text: input.text } : {}),
      ...(input.choice ? { choice: input.choice } : {}),
    };
    const outcome = await runTurn(
      turnInput,
      conversation.state,
      {
        llm,
        dictionary: shopHostValue.dictionary,
        host: shopHostValue.host,
        now: () => new Date(),
        newId: () => randomUUID(),
        evalMode: input.evalMode,
        shopWords: shopHostValue.shopWords,
      },
      (event) => (event.type === "done" ? (held = event) : emit(event)),
    );

    const now = new Date();
    await platform().withShop(caller.shopId, async (tx) => {
      await tx.insert(messages).values([
        {
          shopId: caller.shopId,
          conversationId: conversation.id,
          turnId: outcome.turnId,
          role: "user",
          text: input.text ?? tapped ?? null,
          ...(input.choice ? { meta: { choice: input.choice } } : {}),
        },
        {
          shopId: caller.shopId,
          conversationId: conversation.id,
          turnId: outcome.turnId,
          role: "assistant",
          text: outcome.assistantText,
          meta: outcome.meta,
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
    if (held) emit(held);
  } catch (error) {
    const code = errorCodeOf(error);
    logger().error(
      { err: error, request_id: input.requestId, conversation_id: conversation.id },
      "chat turn failed",
    );
    emit({ type: "error", code, message_key: `errors.${code}`, fatal: true });
    emit({
      type: "done",
      turn_id: (held as { turn_id?: string } | null)?.turn_id ?? input.requestId,
      state: "IDLE",
      timings_ms: {},
    });
  }
}
