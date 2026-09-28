import { readReplyStream, type ReplyEvent } from "@dokaanbondhu/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { TableRecord, Trace, TurnRecord } from "./score";

// One evaluation user talking to the server as the app does (spec 18.4): a Supabase login, a conversation, and chat
// turns whose NDJSON reply is read as it arrives. Every request carries the evaluation key, so the done event has its
// trace. A 429 is waited out for its Retry-After and sent again.

export interface EvalEnv {
  serverUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  evalKey: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  async newConversation(): Promise<string> {
    const response = await this.post("/conversations", { channel: "chat" });
    if (response.status !== 201) throw new Error(`could not open a conversation: http ${response.status}`);
    return ((await response.json()) as { conversation: { id: string } }).conversation.id;
  }

  async chat(conversationId: string, text: string): Promise<TurnRecord> {
    const started = performance.now();
    const response = await this.post("/chat/messages", { conversation_id: conversationId, text });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return {
        sent: text,
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
    await readReplyStream(response.body!.getReader(), (event) => {
      if (event.type === "text" && firstTextMs === null)
        firstTextMs = Math.round(performance.now() - started);
      events.push(event);
    });
    const done = events.find((event) => event.type === "done") as
      Extract<ReplyEvent, { type: "done" }> | undefined;
    const trace = (done?.trace as Trace | undefined) ?? null;
    const choices = events.find((event) => event.type === "choices") as
      Extract<ReplyEvent, { type: "choices" }> | undefined;
    const tables: TableRecord[] = events
      .filter((event): event is Extract<ReplyEvent, { type: "table" }> => event.type === "table")
      .map((table) => ({
        columns: table.columns.map((column) => ({ key: column.key, kind: column.kind })),
        rows: table.rows,
      }));
    const state = done?.state ?? "UNKNOWN";
    return {
      sent: text,
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
    };
  }
}
