import { randomUUID } from "node:crypto";
import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { pcmRms } from "@dokaanbondhu/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TableRecord, Trace, TurnRecord } from "./score";

// One evaluation user talking to the server as the app does (spec 18.4): a Supabase login, a conversation, and chat or
// voice turns whose NDJSON reply is read as it arrives. Every request carries the evaluation key, so the done event
// has its trace and speech always uses our own models (D98). A 429 is waited out for its Retry-After and sent again.

export interface EvalEnv {
  serverUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  evalKey: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const CHUNK_MS = 500;
const CHUNK_BYTES = 16_000; // 500 ms of 16 kHz 16-bit mono

export class Session {
  private readonly client: SupabaseClient;

  constructor(
    private readonly env: EvalEnv,
    private readonly user: { email: string; password: string },
    readonly role: "owner" | "staff",
  ) {
    this.client = createClient(env.supabaseUrl, env.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** A valid access token: the current one, refreshed near its expiry, or a new login. */
  private async token(): Promise<string> {
    const { data } = await this.client.auth.getSession();
    const session = data.session;
    if (session && (session.expires_at ?? 0) * 1000 > Date.now() + 60_000) return session.access_token;
    if (session) {
      const refreshed = await this.client.auth.refreshSession();
      if (refreshed.data.session) return refreshed.data.session.access_token;
    }
    const signedIn = await this.client.auth.signInWithPassword(this.user);
    if (signedIn.error || !signedIn.data.session) {
      throw new Error(`the ${this.role} could not sign in: ${signedIn.error?.message ?? "no session"}`);
    }
    return signedIn.data.session.access_token;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    for (;;) {
      const response = await fetch(`${this.env.serverUrl}/api/v1${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await this.token()}`,
          "x-eval-key": this.env.evalKey,
        },
        body: JSON.stringify(body),
      });
      if (response.status !== 429) return response;
      const seconds = Number(response.headers.get("retry-after") ?? "5");
      await response.body?.cancel();
      await wait((Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000);
    }
  }

  /** The providers in use for this user's shop (GET /me), named by provider. */
  async providers(): Promise<{ chat: string[]; stt: string | null; tts: string | null }> {
    const response = await fetch(`${this.env.serverUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (!response.ok) throw new Error(`GET /me: http ${response.status}`);
    const me = (await response.json()) as {
      providers: {
        llm: { provider: string; model: string | null }[];
        stt: { provider: string } | null;
        tts: { provider: string } | null;
      };
    };
    return {
      chat: me.providers.llm.map((row) => `${row.provider}${row.model ? ` (${row.model})` : ""}`),
      stt: me.providers.stt?.provider ?? null,
      tts: me.providers.tts?.provider ?? null,
    };
  }

  async newConversation(channel: "chat" | "voice" = "chat"): Promise<string> {
    const response = await this.post("/conversations", { channel });
    if (response.status !== 201) throw new Error(`could not open a conversation: http ${response.status}`);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async chat(conversationId: string, text: string): Promise<TurnRecord> {
    const started = performance.now();
    const response = await this.post("/chat/messages", { conversation_id: conversationId, text });
    return readTurn(response, text, started);
  }

  /**
   * One spoken turn as the app sends it (spec 8.4, 18.4): 500 ms chunks of 16 kHz mono PCM, one every 500 ms (real
   * time), then finish; chunks the server reports missing are sent again once.
   */
  async voice(conversationId: string, pcm: Uint8Array, options: { realTime: boolean }): Promise<TurnRecord> {
    const turnId = randomUUID();
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < pcm.byteLength; at += CHUNK_BYTES) chunks.push(pcm.slice(at, at + CHUNK_BYTES));
    const sendChunk = async (seq: number) => {
      const response = await this.postBytes(
        `/voice/turns/${turnId}/chunks?conversation_id=${conversationId}&seq=${seq}`,
        chunks[seq]!,
      );
      await response.body?.cancel();
    };
    for (let seq = 0; seq < chunks.length; seq++) {
      const due = performance.now() + CHUNK_MS;
      await sendChunk(seq);
      if (options.realTime) await wait(Math.max(0, due - performance.now()));
    }
    const body = {
      conversation_id: conversationId,
      chunk_count: chunks.length,
      duration_ms: Math.round((pcm.byteLength / 32_000) * 1000),
      rms: Math.round(pcmRms(pcm) * 10_000) / 10_000,
    };
    const started = performance.now();
    let response = await this.post(`/voice/turns/${turnId}/finish`, body);
    if (response.status === 409) {
      const missing = ((await response.json()) as { error?: { details?: { missing?: number[] } } }).error
        ?.details?.missing;
      for (const seq of missing ?? []) await sendChunk(seq);
      response = await this.post(`/voice/turns/${turnId}/finish`, body);
    }
    return readTurn(response, "(voice)", started);
  }

  private async postBytes(path: string, bytes: Uint8Array): Promise<Response> {
    for (;;) {
      const response = await fetch(`${this.env.serverUrl}/api/v1${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${await this.token()}`,
          "x-eval-key": this.env.evalKey,
        },
        body: new Uint8Array(bytes),
      });
      if (response.status !== 429) return response;
      await response.body?.cancel();
      await wait(Number(response.headers.get("retry-after") ?? "5") * 1000);
    }
  }
}

/** A turn's reply read as it arrives: the text, the state, the trace, and when the first text and audio came. */
async function readTurn(response: Response, sent: string, started: number): Promise<TurnRecord> {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    return {
      sent,
      reply: "",
      state: "ERROR",
      slot: null,
      trace: null,
      tables: [],
      cards: 0,
      errors: [`http ${response.status}: ${body}`],
      firstTextMs: null,
      totalMs: Math.round(performance.now() - started),
    };
  }
  const events: ReplyEvent[] = [];
  let firstTextMs: number | null = null;
  let firstAudioMs: number | null = null;
  await readReplyStream(response.body!.getReader(), (event) => {
    if (event.type === "text" && firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
    if (event.type === "audio" && firstAudioMs === null)
      firstAudioMs = Math.round(performance.now() - started);
    events.push(event);
  });
  const done = events.find((event) => event.type === "done") as
    Extract<ReplyEvent, { type: "done" }> | undefined;
  const trace = (done?.trace as Trace | undefined) ?? null;
  const choices = events.find((event) => event.type === "choices") as
    Extract<ReplyEvent, { type: "choices" }> | undefined;
  const transcript = events.find((event) => event.type === "transcript") as
    Extract<ReplyEvent, { type: "transcript" }> | undefined;
  const tables: TableRecord[] = events
    .filter((event): event is Extract<ReplyEvent, { type: "table" }> => event.type === "table")
    .map((table) => ({
      columns: table.columns.map((column) => ({ key: column.key, kind: column.kind })),
      rows: table.rows,
    }));
  const state = done?.state ?? "UNKNOWN";
  return {
    sent: transcript ? transcript.text : sent,
    reply: events
      .filter((event): event is Extract<ReplyEvent, { type: "text" }> => event.type === "text")
      .map((event) => event.text)
      .join(" "),
    state,
    slot: state === "CLARIFYING" ? (choices?.slot ?? trace?.questions.at(-1) ?? null) : null,
    trace,
    tables,
    cards: events
      .filter((event): event is Extract<ReplyEvent, { type: "cards" }> => event.type === "cards")
      .reduce((sum, event) => sum + event.parts.length, 0),
    errors: events
      .filter((event): event is Extract<ReplyEvent, { type: "error" }> => event.type === "error")
      .map((event) => event.code),
    firstTextMs,
    totalMs: Math.round(performance.now() - started),
    ...(transcript ? { transcript: transcript.text, firstAudioMs, timings: done?.timings_ms ?? {} } : {}),
  };
}
