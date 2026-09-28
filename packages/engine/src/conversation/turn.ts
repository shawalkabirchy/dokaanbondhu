import type { ReplyEvent } from "@dokaanbondhu/contracts";
import {
  AllowedFacts,
  ASK_AGAIN,
  CANNOT_ANSWER_NOW,
  helpAnswer,
  isGrounded,
  matchConcept,
  money,
  noFitmentAnswer,
  normalize,
  partPhrase,
  partsAnswer,
  quantity,
  question,
  resolveCustomer,
  SEE_IN_APP,
  SEE_ON_SCREEN,
  separatingSlot,
  slotChips,
  splitSentences,
  banglaOf,
  formatTaka,
  type Dictionary,
  type PartRow,
  type PartsContext,
  type QuestionSlot,
} from "@dokaanbondhu/core";
import { findParts, type FindPartsResult, type FitmentExtra, type PartQuery } from "../host/find-parts";
import type { Catalog } from "../host/catalog";
import type { RunQuery } from "../host/pool";
import { ReadQueryRejected, runReadQuery, TABLE_ROWS, type ReadQueryResult } from "../host/read-query";
import { getReport, type ReportFormula, type ReportName, type ReportResult } from "../host/reports";
import type { SchemaMap } from "../host/schema-map";
import { llmStream, NothingLeftError, type ChatMessage, type LlmProvider, type ToolCall } from "../providers";
import {
  answerFrame,
  asking,
  correctedSlot,
  isOpen,
  newFrame,
  renew,
  type Offer,
  type RequestFrame,
} from "./frame";
import { systemPrompt } from "./prompt";
import type { ConversationState } from "./state";
import { readTools } from "./tools";

// One chat turn (spec 9.1): normalize, candidates, frame answer, the LLM tool loop (at most 4 calls, D15),
// resolution, decide, respond sentence by sentence with the grounding check (spec 12), and what to persist.

export type PriceTier = "retail" | "garage" | "wholesale";

export interface SessionContext {
  vehicle?: { model: string; year: number | null; engine: string | null };
  customer?: { hostId: string; name: string; tier: PriceTier };
  updatedAt?: string;
}

export const CONTEXT_TTL_MS = 30 * 60_000;

export interface TurnInput {
  text?: string;
  /** Voice: the N-best hypotheses, rank order (the best first). Chat: empty. */
  hypotheses?: string[];
  choice?: { slot: string; optionId: string };
}

export interface TurnHost {
  map: SchemaMap | null;
  run: RunQuery | null;
  catalog: Catalog;
  fitmentExtra: FitmentExtra[];
  rackExtra: ReadonlyMap<string, string>;
  formulas: ReportFormula[];
  hostReports: ReportName[];
}

export interface TurnState {
  state: ConversationState;
  context: SessionContext;
  frame: RequestFrame | null;
  /** The last messages, oldest first (the loop sends the last 6). */
  history: { role: "user" | "assistant"; text: string }[];
}

export interface TurnDeps {
  llm: LlmProvider[];
  dictionary: Dictionary;
  host: TurnHost;
  now: () => Date;
  newId: () => string;
  evalMode: boolean;
  shopWords: string[];
}

export interface TurnTrace {
  tool_calls: { name: string; arguments: unknown; result: string }[];
  /** Every part lookup: what was understood, and the main part numbers found (for the scorer, spec 18.4). */
  lookups: {
    resolved: {
      part_type: string | null;
      vehicle: string | null;
      year: number | null;
      position: string | null;
      quality: string | null;
    };
    result: "rows" | "none" | "ask";
    part_numbers: string[];
  }[];
  questions: string[];
  answer: string;
  grounding_failures: number;
  llm_calls: number;
  /** LLM providers given up on, with the reason ("<id>: http 429"), so a run can stop at a daily limit. */
  fallbacks: string[];
}

export interface TurnOutcome {
  turnId: string;
  state: TurnState;
  assistantText: string;
  meta: {
    timings_ms: Record<string, number>;
    questions: number;
    grounding_failures: number;
    llm_calls: number;
    providers: string[];
    fallbacks: string[];
  };
  trace: TurnTrace;
}

type Emit = (event: ReplyEvent) => void;

const LLM_CALLS = 4;
const TOOL_ROUNDS = 3;
const CALLS_PER_ROUND = 3;
const LIST_KINDS = 4; // a read lists up to four kinds; more are separated by one question

/** The last call's instruction: the answer the staff member needs, with its figures, from the results only. */
const PHRASING = `Answer now, in Bangla, from the tool results only. For parts, name each kind with its quality, stock, \
price in taka and rack, in this pattern: "<গাড়ি> <বছর>-এর <পার্ট> দুই রকম আছে: <মান> <স্টক>, <দাম> টাকা; <মান> <স্টক>, \
<দাম> টাকা। দুটোই <তাক> তাকে।" For other results, give the figures asked for. Copy every number exactly.`;

/** Collects one streamed LLM reply: its text and its tool calls (every call streams, spec 13.3). */
async function collect(
  providers: LlmProvider[],
  messages: ChatMessage[],
  tools: ReturnType<typeof readTools> | [],
  note: (provider: string, fallback?: string) => void,
): Promise<{ text: string; calls: ToolCall[] }> {
  let text = "";
  const calls: ToolCall[] = [];
  for await (const delta of llmStream(
    providers,
    {
      messages,
      ...(tools.length ? { tools, toolChoice: "auto" as const } : { toolChoice: "none" as const }),
      temperature: 0.2,
      maxTokens: tools.length ? 400 : 300,
    },
    { onFallback: (provider, reason) => note(provider, reason) },
  )) {
    if (delta.type === "start") note(delta.providerId);
    if (delta.type === "text") text += delta.text;
    if (delta.type === "tool_calls") calls.push(...delta.calls);
  }
  return { text: text.trim(), calls };
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.arguments || "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function partQueryOf(args: Record<string, unknown>): PartQuery {
  const query: PartQuery = {};
  for (const key of [
    "part_type",
    "vehicle",
    "year",
    "engine",
    "position",
    "quality",
    "brand",
    "part_number",
  ] as const) {
    const value = str(args[key]);
    if (value) query[key] = value;
  }
  return query;
}

function cardsOf(rows: PartRow[]): ReplyEvent {
  return {
    type: "cards",
    parts: rows.map((row) => ({
      host_part_id: row.hostPartId,
      name: row.name,
      name_bn: row.nameBn,
      quality: row.quality,
      position: row.position,
      unit: row.unit,
      stock: row.stock,
      price_paisa: Object.fromEntries(
        (
          [
            ["retail", row.retailPaisa],
            ["garage", row.garagePaisa],
            ["wholesale", row.wholesalePaisa],
          ] as const
        )
          .filter(([, paisa]) => paisa !== null)
          .map(([tier, paisa]) => [tier, Number(paisa)]),
      ),
      rack: row.rack,
      fitment_verified: row.fitmentVerified,
      photo_url: null,
    })),
  };
}

/** What the LLM sees of the rows: taka and the shop's Bangla words as they will be said, never host IDs. */
function rowsForLlm(rows: PartRow[]) {
  return rows.map((row) => ({
    name: row.nameBn ?? row.name,
    quality: row.quality ? banglaOf("quality", row.quality) : null,
    position: row.position ? banglaOf("position", row.position) : null,
    stock: row.stock === null ? null : quantity(row.stock, row.unit ?? "piece"),
    retail_price: row.retailPaisa === null ? null : money(row.retailPaisa),
    garage_price: row.garagePaisa === null ? null : money(row.garagePaisa),
    rack: row.rack,
    fitment_recorded: row.fitmentVerified,
  }));
}

function tableOf(result: ReadQueryResult, title: string): ReplyEvent {
  const kind = (column: ReadQueryResult["columns"][number]) =>
    column.kind === "money"
      ? "money"
      : column.kind === "count"
        ? "count"
        : column.kind === "quantity" || column.kind === "number"
          ? "number"
          : column.kind === "date"
            ? "date"
            : "text";
  return {
    type: "table",
    title,
    columns: result.columns.map((column) => ({ key: column.key, label: column.key, kind: kind(column) })),
    rows: result.rows.slice(0, TABLE_ROWS).map((row) =>
      result.columns.map((column) => {
        const value = row[column.key];
        if (value === null || value === undefined) return null;
        if (typeof value === "bigint") return Number(value);
        if (typeof value === "number") return value;
        return String(value);
      }),
    ),
    truncated: result.rows.length > TABLE_ROWS || result.truncated,
  };
}

/** The facts gathered so far, for the grounding check and the template answer. */
interface Facts {
  allowed: AllowedFacts;
  parts?: { result: Extract<FindPartsResult, { kind: "rows" | "none" }>; context: PartsContext };
  read?: ReadQueryResult;
  report?: ReportResult;
}

function templateAnswer(facts: Facts): string {
  if (facts.report) {
    if (facts.report.kind === "see_in_app") return SEE_IN_APP;
    return `স্টকের মোট দাম ${formatTaka(facts.report.paisa)} টাকা।`;
  }
  if (facts.parts) {
    const { result, context } = facts.parts;
    if (result.kind === "rows") return partsAnswer(result.rows, context, result.pairUsed);
    return noFitmentAnswer(context, [...result.closeVehicle, ...result.mentioned]);
  }
  if (facts.read) return SEE_ON_SCREEN;
  return helpAnswer();
}

export async function runTurn(
  input: TurnInput,
  current: TurnState,
  deps: TurnDeps,
  emit: Emit,
): Promise<TurnOutcome> {
  const started = Date.now();
  const now = deps.now();
  const turnId = deps.newId();
  const timings: Record<string, number> = {};
  const mark = (key: string, since: number) => (timings[key] = Date.now() - since);
  const providers: string[] = [];
  const fallbacks: string[] = [];
  const note = (provider: string, fallback?: string) =>
    fallback ? fallbacks.push(`${provider}: ${fallback}`) : providers.push(provider);
  const trace: TurnTrace = {
    tool_calls: [],
    lookups: [],
    questions: [],
    answer: "",
    grounding_failures: 0,
    llm_calls: 0,
    fallbacks: [],
  };
  const state: TurnState = { ...current, history: [...current.history] };
  const text = input.text?.trim() ?? "";
  const hypotheses = input.hypotheses?.length ? input.hypotheses : text ? [text] : [];
  const others = hypotheses.slice(1);

  // Session context expires after 30 minutes without a turn (spec 9.8).
  if (state.context.updatedAt && now.getTime() - Date.parse(state.context.updatedAt) > CONTEXT_TTL_MS)
    state.context = {};
  const frameOpen = isOpen(state.frame, now);
  if (state.frame && !frameOpen && state.frame.status === "active")
    state.frame = { ...state.frame, status: "expired" };

  emit({ type: "status", state: "UNDERSTANDING", label_key: "status.searching" });
  state.state = "UNDERSTANDING";

  let since = Date.now();
  hypotheses.forEach((hypothesis) => normalize(hypothesis, deps.dictionary.variants));
  mark("normalize", since);
  since = Date.now();
  const candidates = (["part_type", "vehicle_model", "quality", "position"] as const)
    .map((concept) => {
      const best = hypotheses[0]
        ? matchConcept(concept, hypotheses[0], others, deps.dictionary).candidates[0]
        : undefined;
      return best && best.score >= 0.7 ? `${concept} ${best.value} (${best.score.toFixed(2)})` : null;
    })
    .filter(Boolean) as string[];
  mark("candidates", since);

  const facts: Facts = { allowed: new AllowedFacts() };
  facts.allowed.addFromText(text); // values the user said
  if (state.context.vehicle?.year) facts.allowed.addNumber(state.context.vehicle.year);
  let questionsAsked = 0;
  let final:
    | { kind: "answer"; text: string }
    | { kind: "question"; text: string; slot: string; offers: Offer[] }
    | null = null;

  const tier: PriceTier = state.context.customer?.tier ?? "retail";

  const ask = (frame: RequestFrame, slot: string, text: string, offers: Offer[]) => {
    asking(frame, slot, offers);
    renew(frame, now);
    state.frame = frame;
    questionsAsked++;
    trace.questions.push(slot);
    final = { kind: "question", text, slot, offers };
  };

  const partsContext = (query: PartQuery, result: FindPartsResult): PartsContext => ({
    vehicle: result.resolved.vehicle ?? query.vehicle ?? "",
    year: result.resolved.year,
    yearRange:
      !result.resolved.year && result.kind === "rows" && result.rows[0]?.vehicle
        ? [result.rows[0].vehicle.yearFrom, result.rows[0].vehicle.yearTo]
        : null,
    partType: result.resolved.partType ?? query.part_type ?? "",
    position: result.resolved.position,
    tier,
  });

  /** find_parts with its outcome handled: a question, facts for the answer, or nothing. */
  const findAndDecide = async (query: PartQuery, frame: RequestFrame): Promise<"asked" | "facts"> => {
    const resolveStart = Date.now();
    const result = await findParts({
      query,
      hypotheses: others,
      map: deps.host.map!,
      run: deps.host.run!,
      catalog: deps.host.catalog,
      dictionary: deps.dictionary,
      fitmentExtra: deps.host.fitmentExtra,
      rackExtra: deps.host.rackExtra,
      now,
    });
    timings.resolve = (timings.resolve ?? 0) + (Date.now() - resolveStart);
    const partNumbers = (hostId: string) =>
      deps.host.catalog.parts.find((part) => part.hostId === hostId)?.partNumbers[0] ?? hostId;
    trace.lookups.push({
      resolved: {
        part_type: result.resolved.partType,
        vehicle: result.resolved.vehicle,
        year: result.resolved.year,
        position: result.resolved.position,
        quality: result.resolved.quality,
      },
      result: result.kind,
      part_numbers: result.kind === "rows" ? result.rows.map((row) => partNumbers(row.hostPartId)) : [],
    });
    for (const [key, value] of Object.entries(query)) {
      frame.slots[key] = { value, status: "understood", source: "user" };
    }
    if (result.kind === "ask") {
      const vehicle = result.resolved.vehicle ?? undefined;
      const offers: Offer[] = result.options.map((option, index) => ({
        id: `opt-${index + 1}`,
        label: result.slot === "year" ? option.replace("-", "–") : option,
        value: result.slot === "year" ? option.split("-")[0]! : option,
      }));
      const slot = result.slot === "part_number" ? "part_number" : result.slot;
      const text =
        result.slot === "part_number"
          ? offers.length
            ? `${offers.map((offer) => offer.label).join(" বা ")}, কোনটা?`
            : "এই পার্ট নম্বর পাইনি, আবার বলবেন?"
          : question({ slot: result.slot as QuestionSlot, ...(vehicle ? { vehicle } : {}) });
      if (offers.length)
        emit({ type: "choices", slot, options: offers.map(({ id, label }) => ({ id, label })) });
      ask(frame, slot, text, offers);
      return "asked";
    }
    const context = partsContext(query, result);
    if (result.resolved.vehicle) {
      state.context.vehicle = {
        model: result.resolved.vehicle,
        year: result.resolved.year,
        engine: result.resolved.engine,
      };
    }
    if (result.kind === "rows") {
      facts.allowed.addResult(result.rows).addNumber(result.rows.length);
      for (const row of result.rows) {
        facts.allowed.addRack(row.rack);
        if (row.vehicle) facts.allowed.addNumber(row.vehicle.yearFrom).addNumber(row.vehicle.yearTo ?? null);
      }
      if (result.resolved.year) facts.allowed.addNumber(result.resolved.year);
      emit(cardsOf(result.rows));
      if (result.rows.length > LIST_KINDS) {
        const separated = separatingSlot(result.rows, tier);
        if (separated) {
          const chips = slotChips(separated.slot, separated.options);
          const offers = chips.map((chip, index) => ({
            id: chip.id,
            label: chip.label,
            value: separated.options[index]!.value,
          }));
          emit({ type: "choices", slot: separated.slot, options: chips });
          ask(
            frame,
            separated.slot,
            question({ slot: separated.slot as QuestionSlot, vehicle: context.vehicle }),
            offers,
          );
          return "asked";
        }
      }
    } else {
      facts.allowed.addResult([...result.closeVehicle, ...result.mentioned]);
    }
    facts.parts = { result, context };
    frame.status = "done";
    state.frame = frame;
    return "facts";
  };

  /** Runs one tool call; returns the tool result for the LLM, or "stop" when the turn has its reply. */
  const runTool = async (call: ToolCall): Promise<string | "stop"> => {
    const args = parseArgs(call);
    const record = (result: string) => trace.tool_calls.push({ name: call.name, arguments: args, result });
    switch (call.name) {
      case "find_parts": {
        if (!deps.host.map || !deps.host.run) {
          record("no_connection");
          return JSON.stringify({ error: "no shop database connected" });
        }
        const frame = newFrame(deps.newId(), "find_parts", now, text);
        const outcome = await findAndDecide(partQueryOf(args), frame);
        record(outcome === "asked" ? "question" : (facts.parts?.result.kind ?? "facts"));
        if (outcome === "asked") return "stop";
        const result = facts.parts!.result;
        return result.kind === "rows"
          ? JSON.stringify({
              asked_for: partPhrase(facts.parts!.context, result.pairUsed ?? undefined),
              kinds: result.rows.length,
              parts: rowsForLlm(result.rows),
              pair_used: result.pairUsed,
            })
          : JSON.stringify({
              found: 0,
              fitment_recorded: false,
              offers_not_recorded_for_this_car: rowsForLlm([...result.closeVehicle, ...result.mentioned]),
            });
      }
      case "run_read_query": {
        if (!deps.host.map || !deps.host.run) {
          record("no_connection");
          return JSON.stringify({ error: "no shop database connected" });
        }
        try {
          const result = await runReadQuery(deps.host.map, deps.host.run, String(args.sql ?? ""));
          facts.read = result;
          facts.allowed.addResult(result.rows).addNumber(result.rows.length);
          emit(tableOf(result, str(args.purpose) ?? ""));
          record(`rows:${result.rows.length}`);
          const forLlm = result.rows
            .slice(0, 20)
            .map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  typeof value === "bigint" ? formatTaka(value, { bangla: false }) : value,
                ]),
              ),
            );
          const spoken = result.columns
            .filter((column) => column.kind !== "unscaled")
            .map((column) => column.key);
          return JSON.stringify({
            rows: forLlm,
            row_count: result.rows.length,
            money_in_taka: true,
            speakable_columns: spoken,
          });
        } catch (error) {
          const message = error instanceof ReadQueryRejected ? error.message : "the query failed";
          record(`rejected: ${message}`);
          return JSON.stringify({ error: message });
        }
      }
      case "get_report": {
        const name = String(args.name ?? "") as ReportName;
        if (!["stock_value", "profit_loss", "cash_book"].includes(name) || !deps.host.map || !deps.host.run) {
          facts.report = { kind: "see_in_app", name: "profit_loss" };
          record("see_in_app");
          return "stop";
        }
        const result = await getReport({
          name,
          from: str(args.from) ?? null,
          to: str(args.to) ?? null,
          map: deps.host.map,
          run: deps.host.run,
          formulas: deps.host.formulas,
          hostReports: deps.host.hostReports,
        });
        facts.report = result;
        record(result.kind);
        if (result.kind === "see_in_app") return "stop";
        facts.allowed.addMoney(result.paisa);
        return JSON.stringify({
          report: name,
          taka: formatTaka(result.paisa, { bangla: false }),
          from: result.from,
          to: result.to,
        });
      }
      case "resolve_customer": {
        const match = resolveCustomer(
          String(args.name ?? ""),
          others,
          deps.host.catalog.customers,
          deps.dictionary,
        );
        const [first, second] = match.candidates;
        if (match.decision === "ambiguous" && first && second) {
          const frame = newFrame(deps.newId(), "resolve_customer", now, text);
          const offers = [first, second].map((candidate, index) => ({
            id: `opt-${index + 1}`,
            label: candidate.customer.name,
            value: candidate.customer.hostId,
          }));
          emit({
            type: "choices",
            slot: "customer",
            options: offers.map(({ id, label }) => ({ id, label })),
          });
          ask(
            frame,
            "customer",
            question({ slot: "customer", names: offers.map((offer) => offer.label) }),
            offers,
          );
          record("ambiguous");
          return "stop";
        }
        if (!first || match.decision === "unclear") {
          record("unclear");
          return JSON.stringify({ found: false });
        }
        const customer = deps.host.catalog.customers.find((c) => c.hostId === first.customer.hostId);
        const tierOf = String(customer?.attrs?.price_tier ?? customer?.attrs?.type ?? "retail");
        state.context.customer = {
          hostId: first.customer.hostId,
          name: first.customer.name,
          tier: tierOf === "garage" || tierOf === "wholesale" ? tierOf : "retail",
        };
        record("resolved");
        return JSON.stringify({ customer: first.customer.name });
      }
      case "ask_user": {
        const slot = str(args.slot) ?? "other";
        const frame =
          state.frame && isOpen(state.frame, now)
            ? state.frame
            : newFrame(deps.newId(), "ask_user", now, text);
        const options = Array.isArray(args.options) ? args.options.map(String).slice(0, 6) : [];
        const offers = options.map((option, index) => ({
          id: `opt-${index + 1}`,
          label: option,
          value: option,
        }));
        const known: QuestionSlot[] = [
          "year",
          "quality",
          "position",
          "engine",
          "quantity",
          "payment",
          "vehicle",
          "part_type",
        ];
        const questionText = known.includes(slot as QuestionSlot)
          ? question({
              slot: slot as QuestionSlot,
              ...(state.context.vehicle ? { vehicle: state.context.vehicle.model } : {}),
            })
          : (str(args.question) ?? question({ slot: "other" }));
        if (offers.length)
          emit({ type: "choices", slot, options: offers.map(({ id, label }) => ({ id, label })) });
        ask(frame, slot, questionText, offers);
        record("question");
        return "stop";
      }
      default:
        record("unknown_tool");
        return JSON.stringify({ error: `no tool ${call.name}` });
    }
  };

  // Stage 4: the frame answer. A question's answer fills its slot and the request runs again, without the LLM.
  since = Date.now();
  let request = text;
  if (frameOpen && state.frame) {
    const frame = state.frame;
    const filled = answerFrame(frame, {
      ...(input.text ? { text: input.text } : {}),
      ...(input.choice ? { choice: input.choice } : {}),
      dictionary: deps.dictionary,
      customers: deps.host.catalog.customers,
      now,
    });
    const correction = filled ? null : correctedSlot(text, deps.dictionary, now);
    if (correction && frame.intent === "find_parts")
      frame.slots[correction.slot] = { value: correction.value, status: "understood", source: "user" };
    if ((filled || correction) && frame.intent === "find_parts" && deps.host.map && deps.host.run) {
      renew(frame, now);
      const query = partQueryOf(
        Object.fromEntries(Object.entries(frame.slots).map(([key, slot]) => [key, slot.value])),
      );
      const outcome = await findAndDecide(query, frame);
      trace.tool_calls.push({
        name: "find_parts",
        arguments: query,
        result: outcome === "asked" ? "question" : (facts.parts?.result.kind ?? "facts"),
      });
    } else if (filled === "customer" && frame.intent === "resolve_customer") {
      const slot = frame.slots.customer!;
      const customer = deps.host.catalog.customers.find(
        (c) => c.hostId === slot.hostId || c.hostId === slot.value,
      );
      if (customer) {
        const tierOf = String(customer.attrs?.price_tier ?? customer.attrs?.type ?? "retail");
        state.context.customer = {
          hostId: customer.hostId,
          name: customer.name,
          tier: tierOf === "garage" || tierOf === "wholesale" ? tierOf : "retail",
        };
      }
      frame.status = "done";
      request = `${frame.request ?? text} (${customer?.name ?? ""})`;
    } else if (filled && frame.intent === "ask_user") {
      frame.status = "done";
      request = `${frame.request ?? ""} ${text}`.trim();
    }
  }
  mark("frame", since);

  // Stage 5: the LLM tool loop, unless the frame already has the reply or the facts.
  let llmText: string | null = null;
  const needLlm = !final && !facts.parts && !facts.report && request;
  since = Date.now();
  if (needLlm) {
    const openRequest =
      state.frame && isOpen(state.frame, now) && state.frame.status === "active"
        ? `${state.frame.intent}: ${Object.entries(state.frame.slots)
            .map(([key, slot]) => `${key}=${String(slot.value)}`)
            .join(", ")}`
        : null;
    const vehicle = state.context.vehicle;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemPrompt({
          shopWords: deps.shopWords,
          currentVehicle: vehicle ? `${vehicle.model}${vehicle.year ? ` ${vehicle.year}` : ""}` : null,
          currentCustomer: state.context.customer?.name ?? null,
          openRequest,
        }),
      },
      ...state.history
        .slice(-6)
        .map((message) => ({ role: message.role, content: message.text }) as ChatMessage),
      {
        role: "user",
        content: `${request}${candidates.length ? `\n(candidates: ${candidates.join("; ")})` : ""}`,
      },
    ];
    const tools = readTools(deps.host.map);
    try {
      for (let round = 0; round < TOOL_ROUNDS && trace.llm_calls < LLM_CALLS - 1 && !final; round++) {
        const reply = await collect(deps.llm, messages, tools, note);
        trace.llm_calls++;
        if (!reply.calls.length) {
          llmText = reply.text;
          break;
        }
        messages.push({
          role: "assistant",
          content: reply.text || null,
          tool_calls: reply.calls.slice(0, CALLS_PER_ROUND).map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        let stop = false;
        for (const call of reply.calls.slice(0, CALLS_PER_ROUND)) {
          const result = stop ? JSON.stringify({ skipped: true }) : await runTool(call);
          if (result === "stop") stop = true;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content:
              result === "stop"
                ? JSON.stringify({ done: true })
                : `<tool_result name="${call.name}">${result}</tool_result>`,
          });
        }
        if (stop || final) break;
        if (facts.parts || facts.read || (facts.report && facts.report.kind === "figure")) break; // the facts are here
      }
      // No recorded fitment is always said with the template, never phrased by the LLM, so no fit can be claimed
      // (the grounding check sees numbers, not claims; D88).
      const noFitment = facts.parts?.result.kind === "none";
      if (
        !final &&
        llmText === null &&
        !noFitment &&
        (facts.parts || facts.read || facts.report?.kind === "figure")
      ) {
        messages.push({ role: "user", content: PHRASING });
        const phrasing = await collect(deps.llm, messages, [], note);
        trace.llm_calls++;
        llmText = phrasing.text;
      }
    } catch (error) {
      if (!(error instanceof NothingLeftError)) throw error;
      llmText = null; // the provider chain is out: the template answer for the facts we have
      if (!facts.parts && !facts.read && !facts.report && !final)
        final = { kind: "answer", text: CANNOT_ANSWER_NOW };
    }
  }
  mark("llm", since);

  // Stage 7: decide the reply.
  let reply: string;
  if (final && (final as { kind: string }).kind === "question") {
    reply = (final as { text: string }).text;
    state.state = "CLARIFYING";
  } else if (final) {
    reply = (final as { text: string }).text;
    state.state = "RESPONDING";
  } else if (facts.report?.kind === "see_in_app") {
    reply = SEE_IN_APP;
    state.state = "RESPONDING";
  } else {
    state.state = "RESPONDING";
    const template = templateAnswer(facts);
    if (llmText && trace.tool_calls.length === 0) {
      // The LLM answered without any tool: a request the assistant cannot handle gets the fixed help answer, and
      // questions are templates, never the LLM's own words (spec 9.4, 12.2).
      reply = helpAnswer();
    } else if (llmText) {
      // Stage 8: sentence by sentence, each grounded; a failing one ends the LLM text for this turn.
      const kept: string[] = [];
      let failed = false;
      for (const sentence of splitSentences(llmText)) {
        if (isGrounded(sentence, facts.allowed).ok) {
          kept.push(sentence);
          continue;
        }
        failed = true;
        trace.grounding_failures++;
        break;
      }
      reply = failed ? [...kept, template].join(" ") : kept.join(" ") || template;
    } else {
      reply = facts.parts || facts.read || facts.report ? template : request ? helpAnswer() : ASK_AGAIN;
    }
  }

  const sentences = splitSentences(reply);
  sentences.forEach((sentence, seq) =>
    emit({ type: "text", seq, text: sentence, final: seq === sentences.length - 1 }),
  );
  trace.answer = reply;
  trace.fallbacks = fallbacks;
  const finalState: ConversationState = state.state === "CLARIFYING" ? "CLARIFYING" : "IDLE";
  state.state = finalState;
  state.context.updatedAt = now.toISOString();
  state.history.push(
    { role: "user", text: text || (input.choice ? `(${input.choice.optionId})` : "") },
    { role: "assistant", text: reply },
  );
  state.history = state.history.slice(-6);
  timings.total = Date.now() - started;
  emit({
    type: "done",
    turn_id: turnId,
    state: finalState,
    timings_ms: timings,
    ...(deps.evalMode ? { trace } : {}),
  });
  return {
    turnId,
    state,
    assistantText: reply,
    meta: {
      timings_ms: timings,
      questions: questionsAsked,
      grounding_failures: trace.grounding_failures,
      llm_calls: trace.llm_calls,
      providers,
      fallbacks,
    },
    trace,
  };
}

export { banglaOf };
