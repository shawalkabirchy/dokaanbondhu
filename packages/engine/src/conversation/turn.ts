import type { Remembered, ReplyEvent } from "@dokaanbondhu/contracts";
import {
  AllowedFacts,
  ASK_AGAIN,
  CANNOT_ANSWER_NOW,
  helpAnswer,
  learnableWords,
  missingAnswer,
  isGrounded,
  matchConcept,
  money,
  namesInText,
  type NamedInText,
  noFitmentAnswer,
  normalize,
  parseAmount,
  parseQuantity,
  parseYear,
  priceLevelIn,
  partPhrase,
  racksInText,
  rackText,
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
  banglaNumbers,
  carLabel,
  decisionOf,
  formatTaka,
  resultText,
  writeCueOf,
  type Dictionary,
  type PartRow,
  type PartsContext,
  type QuestionSlot,
  levelPrice,
  type PriceLevel,
  type PriceTier,
} from "@dokaanbondhu/core";
import { findParts, type FindPartsResult, type FitmentExtra, type PartQuery } from "../host/find-parts";
import { customerTier, rackLabels, type AppWords, type Catalog } from "../host/catalog";
import type { RunQuery } from "../host/pool";
import { ReadQueryRejected, runReadQuery, TABLE_ROWS, type ReadQueryResult } from "../host/read-query";
import { getReport, type ReportFormula, type ReportName, type ReportResult } from "../host/reports";
import type { SchemaMap } from "../host/schema-map";
import { llmStream, NothingLeftError, type ChatMessage, type LlmProvider, type ToolCall } from "../providers";
import {
  answerFrame,
  asking,
  correctedSlot,
  followUpSlot,
  isOpen,
  newFrame,
  renew,
  splitCorrection,
  type Offer,
  type RequestFrame,
} from "./frame";
import { llmHistory } from "./history";
import { systemPrompt } from "./prompt";
import type { ConversationState } from "./state";
import { CANNOT_HELP, readTools } from "./tools";
import { executeAction } from "../write/execute";
import { writeTool } from "../write/tool";
import type { ActionRecord, PendingAction, WriteCapability, WriteHost } from "../write/types";
import { advanceWrite, correctWrite, writeFrame, type WriteStep, type WriteTurn } from "./write-flow";

// One chat turn (spec 9.1): normalize, candidates, frame answer, the LLM tool loop (at most 4 calls, D15),
// resolution, decide, respond sentence by sentence with the grounding check (spec 12), and what to persist.

export type { PriceTier };

export interface SessionContext {
  vehicle?: { model: string; year: number | null; engine: string | null };
  customer?: { hostId: string; name: string; tier: PriceTier };
  updatedAt?: string;
}

export const CONTEXT_TTL_MS = 30 * 60_000;
/** The customer, and so their price rate, is forgotten sooner, so the next walk-in is not given it (D125). */
export const CUSTOMER_TTL_MS = 10 * 60_000;

/**
 * What the app's memory line shows (D125, D126): the car and the customer, each with the time it is forgotten, counted
 * from the last turn. The customer's label is the Bangla name when the host keeps one.
 */
export function rememberedOf(
  context: SessionContext,
  customerLabel: (hostId: string, name: string) => string = (_hostId, name) => name,
): Remembered {
  const since = context.updatedAt ? Date.parse(context.updatedAt) : Date.now();
  const until = (ms: number) => new Date(since + ms).toISOString();
  return {
    ...(context.vehicle
      ? {
          vehicle: {
            label: carLabel(context.vehicle.model, context.vehicle.year),
            until: until(CONTEXT_TTL_MS),
          },
        }
      : {}),
    ...(context.customer
      ? {
          customer: {
            label: customerLabel(context.customer.hostId, context.customer.name),
            until: until(CUSTOMER_TTL_MS),
          },
        }
      : {}),
  };
}

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
  /** The owner's choices for the app's own words: price levels, quality, position, unit (D121, D122). */
  appWords?: AppWords;
  /** Which trade price is paikari, when the owner chose one (D146). */
  paikari?: "garage_price" | "wholesale_price" | null;
  /** The API connection's enabled writes (spec 9.6, 11.9); absent: the assistant only reads. */
  writes?: WriteHost;
}

export interface TurnState {
  state: ConversationState;
  context: SessionContext;
  frame: RequestFrame | null;
  /** The last messages, oldest first (the loop sends the last 6). */
  history: { role: "user" | "assistant"; text: string }[];
  /** The action waiting for yes or no (spec 9.9), from action_logs. */
  action?: PendingAction | null;
}

export interface TurnDeps {
  llm: LlmProvider[];
  dictionary: Dictionary;
  host: TurnHost;
  now: () => Date;
  newId: () => string;
  evalMode: boolean;
  shopWords: string[];
  /** The user's role: a write whose required role is owner is not offered to staff (spec 9.6). Default staff. */
  role?: "owner" | "staff";
  /** The user's name, sent as the acting-user header where the host has one (spec 11.9). */
  actingUser?: string;
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
      brand: string | null;
    };
    result: "rows" | "none" | "ask";
    /** Each part found, as its part numbers (all of them, as the catalog has them). */
    parts: string[][];
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
  /**
   * Words learned from an answered question (D102 B): a car or part name that needed a question, as the request had
   * it, and what the answer resolved it to. The server records them as suggestions for the owner.
   */
  learned: { heard: string; concept: "vehicle_model" | "part_type"; value: string }[];
  /** Changes to action_logs the server saves with the turn: a new pending action, or a decided one (spec 9.9). */
  actions: ActionRecord[];
}

/** Tool names the read path already uses: a capability named like one is not offered. */
const READ_TOOL_NAMES = new Set([
  "find_parts",
  "run_read_query",
  "get_report",
  "resolve_customer",
  "ask_user",
  "cannot_help",
]);

/** The writes a user may call as tools: enabled ones their role allows (spec 9.6); compensations never reach here (D52). */
export function offeredWrites(writes: WriteHost | undefined, role: "owner" | "staff"): WriteCapability[] {
  return (writes?.capabilities ?? []).filter(
    (capability) =>
      !READ_TOOL_NAMES.has(capability.name) && (role === "owner" || capability.requiredRole === "staff"),
  );
}

type Emit = (event: ReplyEvent) => void;

const LLM_CALLS = 4;
const TOOL_ROUNDS = 3;
const CALLS_PER_ROUND = 3;
const LIST_KINDS = 4; // a read lists up to four kinds; more are separated by one question

/** The nudge of the forced retry, when the model answered without a tool (D95). */
const USE_A_TOOL =
  "Answer by calling one of the tools. The shop's own customers, suppliers, parts and sales are in its database. " +
  "If the request is not about this shop, call cannot_help.";

/** The last call's instruction, for reads other than parts and for report figures (parts use the template, D95). */
const PHRASING =
  "Answer now, in Bangla, from the tool results only, in one or two short sentences: give the figures asked " +
  "for, and copy every number exactly.";

/** Collects one streamed LLM reply: its text and its tool calls (every call streams, spec 13.3). */
async function collect(
  providers: LlmProvider[],
  messages: ChatMessage[],
  tools: ReturnType<typeof readTools> | [],
  note: (provider: string, fallback?: string) => void,
  choice: "auto" | "required" = "auto",
): Promise<{ text: string; calls: ToolCall[] }> {
  let text = "";
  const calls: ToolCall[] = [];
  for await (const delta of llmStream(
    providers,
    {
      messages,
      ...(tools.length ? { tools, toolChoice: choice } : { toolChoice: "none" as const }),
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

/** Part cards with the one price the answer says: paikari when the question asked it, else retail (D141, D142). */
function cardsOf(rows: PartRow[], tier: PriceLevel): ReplyEvent {
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
      price_taka:
        levelPrice(row, tier) !== null
          ? { [tier]: Number(levelPrice(row, tier)) }
          : row.retailTaka !== null
            ? { retail: Number(row.retailTaka) }
            : {},
      rack: rackText(row),
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
    brand: row.brand,
    stock: row.stock === null ? null : quantity(row.stock, row.unit ?? "piece"),
    retail_price: row.retailTaka === null ? null : money(row.retailTaka),
    paikari_price: levelPrice(row, "paikari") === null ? null : money(levelPrice(row, "paikari")!),
    rack: rackText(row),
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
    return `স্টকের মোট দাম ${formatTaka(facts.report.taka)} টাকা।`;
  }
  if (facts.parts) {
    const { result, context } = facts.parts;
    if (result.kind === "rows") {
      const answer = partsAnswer(result.rows, context, result.pairUsed);
      if (!result.unmet) return answer;
      const asked =
        result.unmet === "quality"
          ? banglaOf("quality", result.resolved.quality ?? "")
          : result.resolved.brand;
      return `${missingAnswer(context, asked ?? "", result.pairUsed)} ${answer}`;
    }
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

  // Session context expires after 30 minutes without a turn, the customer after 10 (spec 9.8, D125).
  const idle = state.context.updatedAt ? now.getTime() - Date.parse(state.context.updatedAt) : 0;
  if (idle > CONTEXT_TTL_MS) state.context = {};
  else if (idle > CUSTOMER_TTL_MS && state.context.customer) {
    state.context = { ...state.context };
    delete state.context.customer;
  }
  const frameOpen = isOpen(state.frame, now);
  if (state.frame && !frameOpen && state.frame.status === "active")
    state.frame = { ...state.frame, status: "expired" };

  emit({ type: "status", state: "UNDERSTANDING", label_key: "status.searching" });
  state.state = "UNDERSTANDING";

  let since = Date.now();
  hypotheses.forEach((hypothesis) => normalize(hypothesis, deps.dictionary.variants));
  mark("normalize", since);
  since = Date.now();
  // The shop's own customers, suppliers and racks named in the request, as stored, so the LLM knows "Eastern
  // Lubricants" is one of them and "সি-২" is rack C-2 (D95, D108). The words of a name are not also a car or a part:
  // "গ্যারেজের" in "নিউ ঢাকা গ্যারেজের" is not grease.
  // A Bangla name the app keeps is matched too, and reported as the stored name (D122).
  const shopNames = [
    ...deps.host.catalog.customers.map((customer) => ({ kind: "customer", ...customer })),
    ...deps.host.catalog.suppliers.map((supplier) => ({ kind: "supplier", ...supplier })),
  ].flatMap(({ kind, name, nameBn }) => [
    { kind, name, stored: name },
    ...(nameBn ? [{ kind, name: nameBn, stored: name }] : []),
  ]);
  const storedName = new Map(shopNames.map((entry) => [`${entry.kind}|${entry.name}`, entry.stored]));
  // Best first, so the better of a name's two spellings is kept.
  const byName = new Map<string, NamedInText>();
  for (const found of namesInText(text, shopNames, deps.dictionary)) {
    const name = storedName.get(`${found.kind}|${found.name}`) ?? found.name;
    if (!byName.has(`${found.kind}|${name}`)) byName.set(`${found.kind}|${name}`, { ...found, name });
  }
  const named = [...byName.values(), ...racksInText(text, rackLabels(deps.host.catalog))];
  const inName = (heard: string) => named.some((name) => ` ${name.heard} `.includes(` ${heard} `));
  // The part type, car, quality and position the request names by itself; they also complete a find_parts call
  // that leaves one out (D118).
  const heardSlots = new Map<string, string>();
  const candidates = (["part_type", "vehicle_model", "quality", "position"] as const)
    .map((concept) => {
      const best = hypotheses[0]
        ? matchConcept(concept, hypotheses[0], others, deps.dictionary).candidates.find(
            (candidate) => !inName(candidate.heard),
          )
        : undefined;
      if (!best || best.score < 0.7) return null;
      heardSlots.set(concept, best.value);
      return `${concept} ${best.value} (${best.score.toFixed(2)})`;
    })
    .filter(Boolean) as string[];
  candidates.push(...named.map((name) => `${name.kind} ${name.name}`));
  const saidYear = text ? parseYear(normalize(text, deps.dictionary.variants).tokens, { now }) : null;
  mark("candidates", since);

  const facts: Facts = { allowed: new AllowedFacts() };
  facts.allowed.addFromText(text); // values the user said
  if (state.context.vehicle?.year) facts.allowed.addNumber(state.context.vehicle.year);
  let questionsAsked = 0;
  const learned: TurnOutcome["learned"] = [];
  let final:
    | { kind: "answer"; text: string }
    | { kind: "question"; text: string; slot: string; offers: Offer[] }
    | { kind: "confirm"; text: string }
    | null = null;
  const role = deps.role ?? "staff";
  const offered = offeredWrites(deps.host.writes, role);
  const actions: ActionRecord[] = [];
  // A write said as an instruction ("…বাকিতে দাও", "joma nao", "kinlam"): the matching capability, which the turn
  // starts even when the model reaches for a search or a lookup first (D140).
  const cueKind = text
    ? writeCueOf(text, {
        partyNamed: named.some((name) => name.kind === "customer" || name.kind === "supplier"),
      })
    : null;
  const cued =
    cueKind && deps.host.writes ? (offered.find((item) => item.template === cueKind) ?? null) : null;

  // Prices are said at retail unless the question itself names a level ("পাইকারি দাম", "garage price"); a
  // remembered customer never changes them, and a question's answer keeps the level of the request it answers (D141).
  const tier: PriceLevel =
    priceLevelIn(
      text,
      named.map((name) => name.heard),
    ) ??
    (frameOpen && state.frame?.request ? priceLevelIn(state.frame.request) : null) ??
    "retail";
  /** A sale is billed at the customer's own level by the shop app; its estimate without a dry run uses the same. */
  const billTier: PriceTier = state.context.customer?.tier ?? "retail";
  /** The customer's Bangla name when the host stores one, for the rate sentence (D119). */
  const customerName = (hostId: string, name: string) =>
    deps.host.catalog.customers.find((customer) => customer.hostId === hostId)?.nameBn ?? name;

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

  /**
   * find_parts with its outcome handled: a question, facts for the answer, or nothing. `remembered` names the slots
   * that came from the session context, not from the user (D125).
   */
  /** One part search (spec 11.5), timed and traced. */
  const lookup = async (query: PartQuery): Promise<FindPartsResult> => {
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
      ...(deps.host.appWords ? { appWords: deps.host.appWords } : {}),
      ...(deps.host.paikari ? { paikari: deps.host.paikari } : {}),
      now,
    });
    timings.resolve = (timings.resolve ?? 0) + (Date.now() - resolveStart);
    const numbersOf = (hostId: string) =>
      deps.host.catalog.parts.find((part) => part.hostId === hostId)?.partNumbers ?? [hostId];
    trace.lookups.push({
      resolved: {
        part_type: result.resolved.partType,
        vehicle: result.resolved.vehicle,
        year: result.resolved.year,
        position: result.resolved.position,
        quality: result.resolved.quality,
        brand: result.resolved.brand,
      },
      result: result.kind,
      parts: result.kind === "rows" ? result.rows.map((row) => numbersOf(row.hostPartId)) : [],
    });
    return result;
  };

  /** Facts for the parts answer: the cards, and every number and rack the answer may say. */
  const partsFacts = (query: PartQuery, result: Exclude<FindPartsResult, { kind: "ask" }>) => {
    if (result.kind === "rows") {
      facts.allowed.addResult(result.rows).addNumber(result.rows.length);
      for (const row of result.rows) {
        for (const rack of row.racks ?? [row.rack]) facts.allowed.addRack(rack);
        if (row.vehicle) facts.allowed.addNumber(row.vehicle.yearFrom).addNumber(row.vehicle.yearTo ?? null);
      }
      if (result.resolved.year) facts.allowed.addNumber(result.resolved.year);
      emit(cardsOf(result.rows, tier));
    } else {
      facts.allowed.addResult([...result.closeVehicle, ...result.mentioned]);
    }
    facts.parts = { result, context: partsContext(query, result) };
  };

  const findAndDecide = async (
    query: PartQuery,
    frame: RequestFrame,
    remembered: ReadonlySet<string> = new Set(),
  ): Promise<"asked" | "facts"> => {
    const result = await lookup(query);
    for (const [key, value] of Object.entries(query)) {
      frame.slots[key] = { value, status: "understood", source: remembered.has(key) ? "context" : "user" };
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
    partsFacts(query, result);
    if (result.kind === "rows" && result.rows.length > LIST_KINDS) {
      const separated = separatingSlot(result.rows, tier);
      if (separated) {
        delete facts.parts; // the cards are shown, the answer waits for the question
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
    frame.status = "done";
    state.frame = frame;
    return "facts";
  };

  /**
   * The LLM's find_parts query completed from the request (D118): a part type, car, position or quality it left out
   * is the request's candidate, and a year it left out or gave in a form that cannot be read is the request's own;
   * an unreadable year the request does not have is dropped, so it is asked.
   */
  const completed = (query: PartQuery): { query: PartQuery; remembered: Set<string> } => {
    const out = { ...query };
    // The year the user said: in this input, or in the request an answer has just finished ("২০১৬ সালের নোয়া",
    // then "সেলফ").
    const said =
      saidYear ??
      (request === text ? null : parseYear(normalize(request, deps.dictionary.variants).tokens, { now }));
    if (out.year && parseYear(normalize(out.year).tokens, { now, bare: true }) === null) delete out.year;
    if (!out.year && said !== null) out.year = String(said);
    for (const [slot, concept] of [
      ["part_type", "part_type"],
      ["vehicle", "vehicle_model"],
      ["position", "position"],
      ["quality", "quality"],
    ] as const) {
      const heard = heardSlots.get(concept);
      if (!out[slot] && heard) out[slot] = heard;
    }
    // The remembered car (D125, D126): it completes a search that names no car; the same car said without a year
    // keeps its year. A year the user did not say is used only for that car (D127): one the LLM gives another car
    // was copied from earlier words, so it is asked instead. A part number is looked up as it is.
    const remembered = new Set<string>();
    if (out.part_number) return { query: out, remembered };
    const car = state.context.vehicle;
    const recall = (slot: "year" | "engine", value: string | null) => {
      if (!out[slot] && value) {
        out[slot] = value;
        remembered.add(slot);
      }
    };
    if (car && !out.vehicle) {
      out.vehicle = car.model;
      remembered.add("vehicle");
      recall("year", car.year === null ? null : String(car.year));
      recall("engine", car.engine);
    } else if (car && out.vehicle && sameCar(out.vehicle, car.model)) {
      if (said === null && !yearInside(out.vehicle))
        recall("year", car.year === null ? null : String(car.year));
      recall("engine", car.engine);
    } else if (out.vehicle && out.year && said === null) {
      delete out.year;
    }
    return { query: out, remembered };
  };

  /** Whether a car as said is the remembered one ("এক্সিওর" and "Toyota Axio"). */
  const sameCar = (said: string, model: string) => {
    const match = matchConcept("vehicle_model", said, [], deps.dictionary);
    return match.decision !== "unclear" && match.candidates[0]?.value === model;
  };
  /** Whether a car as said carries its own year ("Axio 2014"). */
  const yearInside = (said: string) => parseYear(normalize(said).tokens, { now }) !== null;
  /** The car a text names, read as the request's candidates are: the best match scoring 0.7 or more. */
  const carOf = (said: string) => {
    const best = matchConcept("vehicle_model", said, [], deps.dictionary).candidates[0];
    return best && best.score >= 0.7 ? best.value : null;
  };

  /** The write flow's view of this turn (spec 9.6, 11.9). */
  const writeTurn = (said: string): WriteTurn => ({
    capabilities: offered,
    host: deps.host.writes!,
    dictionary: deps.dictionary,
    customers: deps.host.catalog.customers,
    suppliers: deps.host.catalog.suppliers.map((supplier) => ({
      hostId: supplier.hostId,
      name: supplier.name,
      nameBn: supplier.nameBn ?? null,
    })),
    tier: billTier,
    rememberedCustomer: state.context.customer
      ? { hostId: state.context.customer.hostId, name: state.context.customer.name }
      : null,
    now,
    newId: deps.newId,
    request: said,
    // The car a write names is remembered like a search's (D125).
    find: async (query) => {
      const result = await lookup(query);
      if (result.kind !== "ask" && result.resolved.vehicle) {
        state.context.vehicle = {
          model: result.resolved.vehicle,
          year: result.resolved.year,
          engine: result.resolved.engine,
        };
      }
      return result;
    },
    complete: completed,
    emit,
    ask,
  });

  /** A write step in this turn: a question (asked already), the confirmation, an answer, or the parts answer. */
  const tookStep = (frame: RequestFrame, step: WriteStep) => {
    state.frame = frame;
    if (step.kind === "asked") return;
    if (step.kind === "confirm") {
      frame.status = "confirming";
      renew(frame, now);
      state.action = step.action;
      actions.push({
        id: step.action.id,
        capabilityId: step.action.capabilityId,
        status: "pending",
        request: step.action.request,
        preview: step.action.preview,
        idempotencyKey: step.action.idempotencyKey,
      });
      // The customer of a write is remembered, with their price level (D119, D125).
      const customer = step.action.preview.customer;
      const known = customer
        ? deps.host.catalog.customers.find((item) => item.hostId === customer.hostId)
        : null;
      if (customer && known) {
        state.context.customer = {
          hostId: customer.hostId,
          name: known.name,
          tier: customerTier(known.attrs, deps.host.appWords),
        };
      }
      final = { kind: "confirm", text: step.text };
      return;
    }
    frame.status = "done";
    if (step.kind === "parts") {
      if (step.result.kind !== "ask") partsFacts(step.query, step.result);
      return;
    }
    final = { kind: "answer", text: step.text };
  };

  /**
   * The cued write, started from what the model understood: the part it searched for (completed from the request
   * like a search, D118), the customer it looked up, and the quantity, unit cost and amount as the request says them
   * (D140). Its questions and confirmation follow as for the write's own tool.
   */
  const startCued = async (capability: WriteCapability, part: Record<string, unknown>, customer?: string) => {
    const tokens = normalize(text, deps.dictionary.variants).tokens;
    // A quantity only with its unit ("দুই সেট", "5 set", "দুইটা"), so a year is never taken for one.
    const quantity = tokens
      .map((_, index) => parseQuantity(tokens.slice(index, index + 2)))
      .find((said) => said?.unit && said.value <= 1000);
    const per = tokens.findIndex((token) => ["প্রতি", "proti", "per"].includes(token));
    const unitCost = per >= 0 ? parseAmount(tokens.slice(per + 1).join(" ")) : null;
    const party = (kind: string) => named.find((name) => name.kind === kind)?.name;
    const who = customer ?? party("customer");
    const args: Record<string, unknown> =
      capability.template === "payment"
        ? {
            ...(who ? { customer: who } : {}),
            ...(parseAmount(text) !== null ? { amount: String(parseAmount(text)) } : {}),
          }
        : {
            ...(who && capability.template !== "stock_in" ? { customer: who } : {}),
            ...(party("supplier") ? { supplier: party("supplier") } : {}),
            items: [
              {
                part: {
                  ...Object.fromEntries(
                    (["part_type", "vehicle_model", "position", "quality"] as const)
                      .filter((concept) => heardSlots.has(concept))
                      .map((concept) => [
                        concept === "vehicle_model" ? "vehicle" : concept,
                        heardSlots.get(concept),
                      ]),
                  ),
                  ...part,
                },
                ...(quantity ? { quantity: `${quantity.value} ${quantity.unit}` } : {}),
                ...(unitCost !== null ? { unit_cost: String(unitCost) } : {}),
              },
            ],
          };
    const frame = writeFrame(capability, args, writeTurn(text));
    tookStep(frame, await advanceWrite(frame, writeTurn(text)));
    return "stop" as const;
  };

  /** find_parts for the LLM: the tool result, or "stop" when the turn asks a question. */
  const partsTool = async (query: PartQuery, record: (result: string) => void): Promise<string | "stop"> => {
    const frame = newFrame(deps.newId(), "find_parts", now, text);
    const full = completed(query);
    const outcome = await findAndDecide(full.query, frame, full.remembered);
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
        if (cued && cued.template !== "payment") {
          record(`write: ${cued.name}`);
          return startCued(cued, partQueryOf(args) as Record<string, unknown>);
        }
        return partsTool(partQueryOf(args), record);
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
            .filter((column) => column.kind !== "unmapped")
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
        facts.allowed.addMoney(result.taka);
        return JSON.stringify({
          report: name,
          taka: formatTaka(result.taka, { bangla: false }),
          from: result.from,
          to: result.to,
        });
      }
      case "resolve_customer": {
        if (cued) {
          // The write resolves the name itself, and asks between two (D140).
          record(`write: ${cued.name}`);
          return startCued(cued, {}, str(args.name));
        }
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
          // No such customer, and the request names a part and a car but no customer: the LLM took the part for a
          // name ("নোয়া সেল মোটর আছে"), so it is the part search (D118).
          const customerNamed = named.some((name) => name.kind === "customer");
          if (
            !customerNamed &&
            heardSlots.has("part_type") &&
            heardSlots.has("vehicle_model") &&
            deps.host.map &&
            deps.host.run
          )
            return partsTool({}, (result) => record(`part_search: ${result}`));
          record("unclear");
          return JSON.stringify({ found: false });
        }
        const customer = deps.host.catalog.customers.find((c) => c.hostId === first.customer.hostId);
        state.context.customer = {
          hostId: first.customer.hostId,
          name: first.customer.name,
          tier: customerTier(customer?.attrs, deps.host.appWords),
        };
        record("resolved");
        return JSON.stringify({ customer: first.customer.name });
      }
      case "ask_user": {
        if (cued) {
          // The write asks what is missing, in its own order (spec 9.4, D140).
          record(`write: ${cued.name}`);
          return startCued(cued, {});
        }
        const slot = str(args.slot) ?? "other";
        // The car asked for while one is remembered and the request names a part and no car: the part search for the
        // remembered car, whose answer names it (D125, D126).
        if (
          (slot === "vehicle" || slot === "vehicle_model") &&
          state.context.vehicle &&
          heardSlots.has("part_type") &&
          !heardSlots.has("vehicle_model") &&
          deps.host.map &&
          deps.host.run
        )
          return partsTool({}, (result) => record(`part_search: ${result}`));
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
      case "cannot_help": {
        // The model says the request is not about the shop: the fixed help answer (spec 12.2).
        record("cannot_help");
        final = { kind: "answer", text: helpAnswer() };
        return "stop";
      }
      default: {
        // A capability's tool: its frame, then a question or the confirmation; the LLM's text is not used (spec 9.5).
        const capability = offered.find((item) => item.name === call.name);
        if (capability && deps.host.writes) {
          const frame = writeFrame(capability, args, writeTurn(text));
          record("write");
          tookStep(frame, await advanceWrite(frame, writeTurn(text)));
          return "stop";
        }
        record("unknown_tool");
        return JSON.stringify({ error: `no tool ${call.name}` });
      }
    }
  };

  // Stage 4: the frame answer. A question's answer fills its slot and the request runs again, without the LLM.
  since = Date.now();
  let request = text;
  // A confirmation waiting for yes or no (spec 9.9): yes sends it, no cancels it, a correction changes its slot and
  // confirms again, anything else repeats it. An expired one is cancelled, and said so when the input was yes or no.
  const pending = state.action ?? null;
  if (pending) {
    state.action = null;
    const frame = state.frame?.status === "confirming" ? state.frame : null;
    const capability = offered.find((item) => item.id === pending.capabilityId) ?? null;
    const decision = input.text ? decisionOf(text) : null;
    const cancel = () => {
      actions.push({ id: pending.id, capabilityId: pending.capabilityId, status: "cancelled" });
      emit({ type: "action_result", action_id: pending.id, status: "cancelled", undo_available: false });
    };
    if (Date.parse(pending.expiresAt) <= now.getTime() || !frame || !capability || !deps.host.writes) {
      cancel();
      if (frame) state.frame = { ...frame, status: "expired" };
      if (decision) final = { kind: "answer", text: resultText("expired", pending.preview.template) };
    } else if (decision === "yes") {
      emit({ type: "status", state: "EXECUTING", label_key: "status.saving" });
      const result = await executeAction({
        capability,
        action: pending,
        host: deps.host.writes,
        actingUser: deps.actingUser ?? "",
        read: deps.host.map && deps.host.run ? { map: deps.host.map, run: deps.host.run } : null,
        now: deps.now,
      });
      actions.push({
        id: pending.id,
        capabilityId: pending.capabilityId,
        status: result.status,
        response: result.response,
        verifyStatus: result.verifyStatus,
        confirmedAt: now.toISOString(),
        doneAt: deps.now().toISOString(),
      });
      emit({
        type: "action_result",
        action_id: pending.id,
        status: result.status,
        undo_available: result.undoAvailable,
      });
      frame.status = "done";
      state.frame = frame;
      final = { kind: "answer", text: result.text };
    } else if (decision === "no") {
      cancel();
      frame.status = "cancelled";
      state.frame = frame;
      final = { kind: "answer", text: resultText("cancelled", pending.preview.template) };
    } else if (input.text && correctWrite(frame, text, capability, writeTurn(frame.request ?? text))) {
      cancel();
      frame.status = "active";
      renew(frame, now);
      tookStep(frame, await advanceWrite(frame, writeTurn(frame.request ?? text)));
    } else {
      state.action = pending;
      emit({
        type: "confirm",
        action_id: pending.id,
        text: pending.preview.text,
        fields: pending.preview.fields,
        warnings: pending.preview.warnings,
        expires_at: pending.expiresAt,
      });
      final = { kind: "confirm", text: pending.preview.text };
    }
  }
  // An input that names another car than the waiting request's, while it asks anything but the car, is a new request:
  // "নোয়া সেলফ মোটর আছে?" after "কোন পার্ট লাগবে?" about an Axio. The waiting one is set aside and the input goes to
  // the LLM without it; "না, প্রিমিও" stays a correction (spec 9.3 rule 3, D127).
  if (
    !final &&
    frameOpen &&
    state.frame &&
    state.frame.asking !== "vehicle" &&
    !splitCorrection(text).correction
  ) {
    const heardCar = heardSlots.get("vehicle_model");
    const asked = state.frame.slots.vehicle?.value;
    const frameCar =
      typeof asked === "string" ? carOf(asked) : state.frame.request ? carOf(state.frame.request) : null;
    if (heardCar && frameCar && heardCar !== frameCar) state.frame = { ...state.frame, status: "set_aside" };
  }
  if (!final && frameOpen && state.frame && state.frame.status === "active") {
    const frame = state.frame;
    // What the request had for the asked slot, before the answer replaces it (D102 B).
    const asked = frame.asking;
    const heardBefore = asked ? frame.slots[asked]?.value : undefined;
    const filled = answerFrame(frame, {
      ...(input.text ? { text: input.text } : {}),
      ...(input.choice ? { choice: input.choice } : {}),
      dictionary: deps.dictionary,
      customers: deps.host.catalog.customers,
      suppliers: deps.host.catalog.suppliers.map((supplier) => ({
        hostId: supplier.hostId,
        name: supplier.name,
        nameBn: supplier.nameBn ?? null,
      })),
      now,
    });
    const correction = filled ? null : correctedSlot(text, deps.dictionary, now);
    if ((filled || correction) && frame.capabilityId && deps.host.writes) {
      // A write's answer, or "না, X" for a part detail: the write goes on from where it was (spec 9.3 rule 3).
      if (correction) {
        frame.slots[correction.slot] = { value: correction.value, status: "understood", source: "user" };
        delete frame.slots.part;
        delete frame.slots.part_pick;
      }
      renew(frame, now);
      tookStep(frame, await advanceWrite(frame, writeTurn(frame.request ?? text)));
    }
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
      // A car or part name that needed a question and is now resolved: how the request had it may be learned.
      if ((filled === "vehicle" || filled === "part_type") && typeof heardBefore === "string") {
        const resolved = trace.lookups.at(-1)?.resolved;
        const value = filled === "vehicle" ? resolved?.vehicle : resolved?.part_type;
        const words = value ? learnableWords(heardBefore, deps.dictionary) : null;
        if (value && words)
          learned.push({
            heard: words,
            concept: filled === "vehicle" ? "vehicle_model" : "part_type",
            value,
          });
      }
    } else if (filled === "customer" && frame.intent === "resolve_customer") {
      const slot = frame.slots.customer!;
      const customer = deps.host.catalog.customers.find(
        (c) => c.hostId === slot.hostId || c.hostId === slot.value,
      );
      if (customer) {
        state.context.customer = {
          hostId: customer.hostId,
          name: customer.name,
          tier: customerTier(customer.attrs, deps.host.appWords),
        };
      }
      frame.status = "done";
      request = `${frame.request ?? text} (${customer?.name ?? ""})`;
    } else if (filled && frame.intent === "ask_user") {
      frame.status = "done";
      request = `${frame.request ?? ""} ${text}`.trim();
    }
  }
  // A short follow-up to the last part search ("pechoner ta?", "genuine ta?"): that search again with one detail
  // changed, without the LLM (spec 9.8, D95).
  const last = state.frame;
  // It needs the remembered car, so a car forgotten in the app is not reused (D126).
  const recent =
    !frameOpen &&
    !input.choice &&
    last?.intent === "find_parts" &&
    last.status === "done" &&
    state.context.vehicle !== undefined &&
    state.context.updatedAt !== undefined &&
    now.getTime() - Date.parse(state.context.updatedAt) <= CONTEXT_TTL_MS;
  const followUp = recent && text ? followUpSlot(text, deps.dictionary, now) : null;
  if (followUp && last && deps.host.map && deps.host.run) {
    const frame = newFrame(deps.newId(), "find_parts", now, text);
    frame.slots = {
      ...last.slots,
      [followUp.slot]: { value: followUp.value, status: "understood", source: "user" },
    };
    const query = partQueryOf(
      Object.fromEntries(Object.entries(frame.slots).map(([key, slot]) => [key, slot.value])),
    );
    const remembered = new Set(
      Object.entries(frame.slots)
        .filter(([, slot]) => slot.source === "context")
        .map(([key]) => key),
    );
    const outcome = await findAndDecide(query, frame, remembered);
    trace.tool_calls.push({
      name: "find_parts",
      arguments: query,
      result: outcome === "asked" ? "question" : (facts.parts?.result.kind ?? "facts"),
    });
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
      // Only as much of the past as the request needs: none when it names its own part and car (D125, D126).
      ...llmHistory(state.history, {
        selfContained: !openRequest && heardSlots.has("part_type") && heardSlots.has("vehicle_model"),
      }),
      {
        role: "user",
        content: `${request}${candidates.length ? `\n(candidates: ${candidates.join("; ")})` : ""}${
          cued ? `\n(this asks to record it: call ${cued.name})` : ""
        }`,
      },
    ];
    const tools = [...readTools(deps.host.map), ...offered.map(writeTool)];
    try {
      let forced = false;
      for (let round = 0; round < TOOL_ROUNDS && trace.llm_calls < LLM_CALLS - 1 && !final; round++) {
        let reply = await collect(deps.llm, messages, tools, note);
        trace.llm_calls++;
        if (
          !reply.calls.length &&
          !forced &&
          trace.tool_calls.length === 0 &&
          trace.llm_calls < LLM_CALLS - 1
        ) {
          // The model answered in its own words: once more, it must choose a tool, or cannot_help (D95).
          forced = true;
          reply = await collect(
            deps.llm,
            [...messages, { role: "user", content: USE_A_TOOL }],
            [...tools, CANNOT_HELP],
            note,
            "required",
          );
          trace.llm_calls++;
        }
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
      // Parts are always said with the template: it is complete (every kind, stock, price, rack), in the shop's
      // Bangla words, and never claims a fit (D88, D95). The LLM phrases the other reads and report figures.
      if (!final && llmText === null && !facts.parts && (facts.read || facts.report?.kind === "figure")) {
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
  } else if (final && (final as { kind: string }).kind === "confirm") {
    reply = (final as { text: string }).text;
    state.state = "CONFIRMING";
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
      // Stage 8: sentence by sentence, each grounded; a failing one ends the LLM text for this turn. A kept sentence
      // writes its numbers as the answers do, in Bangla digits (D118).
      const kept: string[] = [];
      let failed = false;
      for (const sentence of splitSentences(llmText)) {
        if (isGrounded(sentence, facts.allowed).ok) {
          kept.push(banglaNumbers(sentence));
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
  const finalState: ConversationState = state.action
    ? "CONFIRMING"
    : state.state === "CLARIFYING"
      ? "CLARIFYING"
      : "IDLE";
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
    context: rememberedOf(state.context, customerName),
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
    learned,
    actions,
  };
}

export { banglaOf };
