import type { Remembered, ReplyEvent } from "@dokaanbondhu/contracts";
import {
  asciiDigits,
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
  parseYearRange,
  priceLevelIn,
  partPhrase,
  racksInText,
  rackText,
  numberAnswer,
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
  isWriteWord,
  ownerOnlyText,
  saidMoney,
  saidNumbers,
  type Dictionary,
  type PartRow,
  type PartsContext,
  type QuestionSlot,
  levelPrice,
  type PriceLevel,
  type PriceTier,
  type YearRange,
  yearRangeText,
  NEW_PARTY,
  alsoCarWords,
  banglaDigits,
  daysBefore,
  lowStockAnswer,
  oldDuesAnswer,
  reminderCueOf,
  type ReminderKind,
} from "@dokaanbondhu/core";
import { cleanTranscript, nearHints } from "./near-words";
import { commonValues } from "./keyterms";
import {
  findParts,
  resolveCar,
  type FindPartsResult,
  type FitmentExtra,
  type PartQuery,
  type Resolved,
} from "../host/find-parts";
import { customerTier, rackLabels, type AppWords, type Catalog } from "../host/catalog";
import { HostCallFailed } from "../host/api";
import type { RunQuery } from "../host/pool";
import {
  READ_ONLY_REFUSAL,
  ReadQueryRejected,
  runReadQuery,
  TABLE_ROWS,
  type ReadQueryResult,
} from "../host/read-query";
import { hostReport, reportNamesOf, syncNote } from "../host/host-features";
import { getReport, type ReportFormula, type ReportName, type ReportResult } from "../host/reports";
import { lowStock, oldDues, REMINDER_ROWS, type LowStock, type OldDue } from "../host/reminders";
import type { SchemaMap } from "../host/schema-map";
import {
  llmStream,
  NothingLeftError,
  toolCallsInText,
  type ChatMessage,
  type LlmProvider,
  type ToolCall,
} from "../providers";
import {
  answeredSlots,
  answerFrame,
  asking,
  carChanged,
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
import { boughtParts, findSales } from "../write/sale-finder";
import { fitRecorded } from "../write/verify";
import { writeTool } from "../write/tool";
import type { ActionRecord, PendingAction, WriteCapability, WriteHost } from "../write/types";
import {
  addedRecord,
  advanceWrite,
  clearAdding,
  correctWrite,
  OWN_RACK_ID,
  ownRackCapability,
  writeFrame,
  type AddedRecord,
  type WriteStep,
  type WriteTurn,
} from "./write-flow";

// One chat turn (spec 9.1): normalize, candidates, frame answer, the LLM tool loop (at most 4 calls, D15),
// resolution, decide, respond sentence by sentence with the grounding check (spec 12), and what to persist.

export type { PriceTier };

export interface SessionContext {
  /** `years`: a year button's car years, kept so the same car's next search picks the same rows (D167). */
  vehicle?: { model: string; year: number | null; years?: YearRange; engine: string | null };
  customer?: { hostId: string; name: string; tier: PriceTier };
  updatedAt?: string;
}

/** The car a part search resolved, as remembered (D125), with a year button's car years (D167). */
function rememberedCar(resolved: Resolved): NonNullable<SessionContext["vehicle"]> {
  return {
    model: resolved.vehicle!,
    year: resolved.year,
    ...(resolved.years ? { years: resolved.years } : {}),
    engine: resolved.engine,
  };
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
  /** The owner lets staff set a sale's price (the shop setting staff_price_override, D176). */
  staffPriceOverride?: boolean;
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
    /** A part found by its number: the cars it is recorded for, as make-model-year (D186). */
    cars?: string[];
  }[];
  questions: string[];
  answer: string;
  grounding_failures: number;
  llm_calls: number;
  /** Words of the transcript the LLM chose among the shop's near names, before anything else (D153). */
  cleanup?: { heard: string; meant: string }[];
  /** LLM providers given up on, with the reason ("<id>: http 429"), so a run can stop at a daily limit. */
  fallbacks: string[];
  /** An action put on the Yes/No sheet: what it would save, for the scorer (spec 18.4, D185). */
  action?: ActionTrace;
}

export interface ActionTrace {
  capability: string;
  /** The template kind: sale, payment, stock_in, return, price_update, add_fitment, add_customer, add_supplier. */
  template: string;
  customer: string | null;
  supplier: string | null;
  new_party: { name: string; type: string | null; phone: string | null } | null;
  /** The parts on the sheet, each with its quantity and its part numbers. */
  lines: { part_numbers: string[]; quantity: number }[];
  /** The parts and the car the request names by their IDs (a price change's part, a fitment's car). */
  parts: string[][];
  vehicle: { model: string; year_from: number } | null;
  total: number | null;
  paid: number;
  request: { method: string; path: string; body: unknown };
}

/** Every string and number a request carries, in its path and body. */
function requestValues(pending: PendingAction): Set<string> {
  const values = new Set<string>(pending.request.path.split("/").filter(Boolean).map(decodeURIComponent));
  const walk = (node: unknown) => {
    if (typeof node === "string" || typeof node === "number") values.add(String(node));
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(pending.request.body);
  return values;
}

/** What a waiting action would save, as the scorer reads it: names, part numbers and the car, not host IDs. */
export function actionTrace(pending: PendingAction, capabilityName: string, catalog: Catalog): ActionTrace {
  const { preview } = pending;
  const values = requestValues(pending);
  const numbersOf = (hostId: string) =>
    catalog.parts.find((part) => part.hostId === hostId)?.partNumbers ?? [];
  const vehicle = catalog.vehicles.find((item) => values.has(item.hostId));
  return {
    capability: capabilityName,
    template: preview.template,
    customer: preview.customer?.name ?? null,
    supplier: preview.supplier?.name ?? null,
    new_party: preview.newParty
      ? { name: preview.newParty.name, type: preview.newParty.type, phone: preview.newParty.phone }
      : null,
    lines: preview.lines.map((line) => ({
      part_numbers: numbersOf(line.hostPartId),
      quantity: line.quantity,
    })),
    parts: catalog.parts.filter((part) => values.has(part.hostId)).map((part) => part.partNumbers),
    vehicle: vehicle
      ? { model: `${vehicle.make} ${vehicle.model}`.trim(), year_from: vehicle.yearFrom }
      : null,
    total: preview.total,
    paid: preview.paid,
    request: {
      method: pending.request.method,
      path: pending.request.path,
      body: pending.request.body ?? null,
    },
  };
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
  learned: {
    heard: string;
    concept: "vehicle_model" | "part_type" | "customer" | "supplier";
    value: string;
  }[];
  /** Changes to action_logs the server saves with the turn: a new pending action, or a decided one (spec 9.9). */
  actions: ActionRecord[];
  /** Customers and suppliers the app saved in this turn: the server puts them in the catalog cache at once (D173). */
  added: AddedRecord[];
  /** Racks the user said yes to keeping in DokaanBondhu's own list (D195, D199): the server saves them in rack_extra. */
  racks: { hostPartId: string; rack: string }[];
}

/** The host of a shop app without writes, for DokaanBondhu's own rack list (D199), which never calls an app. */
const NO_WRITES: WriteHost = {
  capabilities: [],
  operations: {},
  features: {},
  call: async () => {
    throw new HostCallFailed("the shop's app takes no writes", "network");
  },
};

/** Tool names the read path already uses: a capability named like one is not offered. */
const READ_TOOL_NAMES = new Set([
  "find_parts",
  "run_read_query",
  "get_reminders",
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
  // A call the model wrote as text is a call, and its markup is never the answer (D188).
  const written = toolCallsInText(text);
  if (written) return { text: written.text, calls: [...calls, ...written.calls] };
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

/** A reminder's list (D194); null when the app does not keep what it needs. */
type ReminderFacts =
  { kind: "low_stock"; lines: LowStock[] | null } | { kind: "old_dues"; lines: OldDue[] | null };

/** The facts gathered so far, for the grounding check and the template answer. */
interface Facts {
  allowed: AllowedFacts;
  parts?: { result: Extract<FindPartsResult, { kind: "rows" | "none" }>; context: PartsContext };
  read?: ReadQueryResult;
  report?: ReportResult;
  reminders?: ReminderFacts[];
}

/** The reminders' answer (D194): each list's sentence, "see the screen" said once at the end. */
function remindersAnswer(reminders: ReminderFacts[]): string {
  const sentences = reminders.map((reminder) =>
    reminder.lines === null
      ? SEE_IN_APP
      : reminder.kind === "low_stock"
        ? lowStockAnswer(reminder.lines)
        : oldDuesAnswer(reminder.lines),
  );
  const last = sentences.length - 1;
  return [
    ...new Set(
      sentences.map((sentence, index) =>
        index < last ? sentence.replace(` ${SEE_ON_SCREEN}`, "") : sentence,
      ),
    ),
  ].join(" ");
}

/** A reminder's list as a table on the screen (D194). */
function reminderTable(reminder: ReminderFacts, now: Date): ReplyEvent | null {
  if (!reminder.lines?.length) return null;
  if (reminder.kind === "low_stock")
    return {
      type: "table",
      title: "কম স্টক",
      columns: [
        { key: "part", label: "পার্ট", kind: "text" },
        { key: "stock", label: "স্টক", kind: "number" },
        { key: "reorder", label: "কমপক্ষে", kind: "number" },
      ],
      rows: reminder.lines.map((line) => [line.nameBn ?? line.name, line.stock, line.reorderLevel]),
      truncated: reminder.lines.length >= REMINDER_ROWS,
    };
  return {
    type: "table",
    title: "পুরোনো বাকি",
    columns: [
      { key: "customer", label: "কাস্টমার", kind: "text" },
      { key: "due", label: "মোট বাকি", kind: "money" },
      { key: "old", label: "পুরোনো বাকি", kind: "money" },
      { key: "age", label: "কত দিনের", kind: "text" },
    ],
    // An opening due (from before every sale) has no day: "শুরুর বাকি".
    rows: reminder.lines.map((line) => [
      line.nameBn ?? line.name,
      Number(line.due),
      Number(line.old),
      line.since ? `${banglaDigits(String(daysBefore(line.since, now)))} দিন` : "শুরুর বাকি",
    ]),
    truncated: reminder.lines.length >= REMINDER_ROWS,
  };
}

/** A read's list of at most this many different names has them said, not only "see the screen" (D160). */
const READ_ALOUD_NAMES = 6;

/**
 * A read's template answer (spec 12.2, D160): a list of two to six different Bangla names is said, from its text
 * columns, those with Bangla names first ("পাওয়া গেছে: সেলফ মোটর, ডায়নামো, হর্ন সেট।"), then "see the screen". One
 * name is a value looked up (a due), which the name alone does not answer; more names, a row without one, or names
 * not in Bangla (the voice speaks Bangla) get only "see the screen".
 */
function readAnswer(result: ReadQueryResult): string {
  const { rows } = result;
  const said = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const bangla = (key: string) => rows.filter((row) => /[ঀ-৿]/.test(said(row[key]) ?? "")).length;
  const columns = result.columns
    .filter((column) => column.kind === "text" && rows.some((row) => said(row[column.key])))
    .sort((a, b) => bangla(b.key) - bangla(a.key));
  const names = rows.map((row) => columns.map((column) => said(row[column.key])).find(Boolean) ?? null);
  const different = [...new Set(names)];
  const inBangla = different.every((name) => name !== null && /[ঀ-৿]/.test(name));
  if (!inBangla || different.length < 2 || different.length > READ_ALOUD_NAMES) return SEE_ON_SCREEN;
  return `পাওয়া গেছে: ${different.join(", ")}। ${SEE_ON_SCREEN}`;
}

function templateAnswer(facts: Facts): string {
  if (facts.reminders?.length) return remindersAnswer(facts.reminders);
  if (facts.report) {
    if (facts.report.kind === "see_in_app") return SEE_IN_APP;
    // Each report its own sentence: an app's own profit or cash figure, or the stock value (D181).
    const taka = formatTaka(facts.report.taka);
    if (facts.report.name === "profit_loss") return `লাভ ${taka} টাকা।`;
    if (facts.report.name === "cash_book") return `ক্যাশে ${taka} টাকা।`;
    return `স্টকের মোট দাম ${taka} টাকা।`;
  }
  if (facts.parts) {
    const { result, context } = facts.parts;
    if (result.kind === "rows") {
      // A part by its number alone: its own sentence, with its cars (D186).
      if (result.number && result.cars)
        return numberAnswer(result.rows, result.number, result.cars, context.tier);
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
  if (facts.read) return readAnswer(facts.read);
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
  const said = input.text?.trim() ?? "";
  const others = (input.hypotheses ?? []).slice(1);

  // Session context expires after 30 minutes without a turn, the customer after 10 (spec 9.8, D125).
  const idle = state.context.updatedAt ? now.getTime() - Date.parse(state.context.updatedAt) : 0;
  if (idle > CONTEXT_TTL_MS) state.context = {};
  else if (idle > CUSTOMER_TTL_MS && state.context.customer) {
    state.context = { ...state.context };
    delete state.context.customer;
  }
  // DokaanBondhu's own rack action has no capability row, so its saved frame comes back without the ID (D199).
  if (state.frame && !state.frame.capabilityId && state.frame.intent === ownRackCapability().name)
    state.frame = { ...state.frame, capabilityId: OWN_RACK_ID };
  const frameOpen = isOpen(state.frame, now);
  if (state.frame && !frameOpen && state.frame.status === "active")
    state.frame = { ...state.frame, status: "expired" };

  emit({ type: "status", state: "UNDERSTANDING", label_key: "status.searching" });
  state.state = "UNDERSTANDING";

  // A word the matcher cannot place is chosen among the shop's nearest names by the LLM, from the whole sentence
  // (D149 C, D153): এসডিও is এক্সিও, নওয়াপুর অটোপাস is Nawabpur Auto Parts Ltd. Not for a yes or no to a waiting action.
  let since = Date.now();
  const askedSlot = frameOpen ? state.frame?.asking : undefined;
  const nameQuestion =
    askedSlot && ["vehicle", "part_type", "brand", "customer", "supplier"].includes(askedSlot)
      ? question({ slot: askedSlot as QuestionSlot })
      : undefined;
  const hints =
    said && !input.choice && !state.action && deps.llm.length
      ? nearHints({
          text: said,
          dictionary: deps.dictionary,
          customers: deps.host.catalog.customers,
          suppliers: deps.host.catalog.suppliers.map((supplier) => ({
            hostId: supplier.hostId,
            name: supplier.name,
            nameBn: supplier.nameBn ?? null,
          })),
        })
      : [];
  const cleaned = hints.length
    ? await cleanTranscript(deps.llm, said, others, hints, deps.dictionary, nameQuestion)
    : { text: said, replaced: [] };
  // The clean-up call is not one of the tool loop's calls (spec 9.5): it shows as timings.cleanup and trace.cleanup.
  if (hints.length) {
    trace.cleanup = cleaned.replaced.map(({ heard, option }) => ({ heard, meant: option.label }));
    mark("cleanup", since);
  }
  const text = cleaned.text;
  const hypotheses = cleaned.replaced.length
    ? [text, ...others]
    : input.hypotheses?.length
      ? input.hypotheses
      : text
        ? [text]
        : [];
  /** The words the LLM chose (D153): a frame slot holding one is shown in bold on the confirmation sheet. */
  const guessed = new Set(
    cleaned.replaced.flatMap(({ option }) =>
      [option.label, option.value].map((word) => normalize(word).tokens.join(" ")),
    ),
  );
  const markGuessed = (frame: RequestFrame): RequestFrame => {
    for (const name of ["customer", "supplier", "vehicle", "part_type"]) {
      const slot = frame.slots[name];
      if (slot && typeof slot.value === "string" && guessed.has(normalize(slot.value).tokens.join(" ")))
        slot.confidence = Math.min(slot.confidence ?? 1, 0.75);
    }
    return frame;
  };
  /**
   * Buttons for a car or part question (D154): the shop's values near a word that was not understood, else its most
   * common ones, so a misheard answer is one tap away.
   */
  const nearOffers = (slot: string): Offer[] => {
    const concept =
      slot === "vehicle" || slot === "vehicle_model"
        ? "vehicle_model"
        : slot === "part_type"
          ? "part_type"
          : null;
    if (!concept) return [];
    const near = new Map<string, string>();
    for (const hint of hints)
      for (const option of hint.options)
        if (option.kind === concept && !near.has(option.value)) near.set(option.value, option.label);
    const values = near.size
      ? [...near]
      : commonValues(deps.host.catalog, deps.dictionary, concept).map(
          (value) => [value, banglaOf(concept, value)] as const,
        );
    return values.slice(0, 3).map(([value, label], index) => ({ id: `opt-${index + 1}`, label, value }));
  };

  since = Date.now();
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
    // How speech-to-text writes the name, learned from corrections and added by the owner (D155).
    ...deps.dictionary.terms
      .filter((term) => term.concept === kind && term.value === name)
      .map((term) => ({ kind, name: term.text, stored: name })),
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
  // Values that tied with a heard slot before the other guesses chose it: the LLM may not choose them instead (D158).
  const tiedSlots = new Map<string, string[]>();
  // The words a part's name of several words was heard in: they are not also a car ("ইয়াল ফিল্ডার" is an air filter,
  // not a Fielder, D158).
  const partWords: string[] = [];
  const inPart = (heard: string) => partWords.some((words) => ` ${words} `.includes(` ${heard} `));
  const candidates = (["part_type", "vehicle_model", "quality", "position"] as const)
    .map((concept) => {
      if (!hypotheses[0]) return null;
      // A write's own words are no part detail: "ফেরত নাও" is not পুরাতন (D169).
      const near = (text: string, extra: readonly string[]) =>
        matchConcept(concept, text, extra, deps.dictionary).candidates.filter(
          (candidate) =>
            !inName(candidate.heard) &&
            !(concept !== "part_type" && inPart(candidate.heard)) &&
            !normalize(candidate.heard).tokens.some(isWriteWord),
        );
      const found = near(hypotheses[0], others);
      let best = found[0];
      if (!best || best.score < 0.7) return null;
      if (concept === "part_type" && best.heard.includes(" ")) partWords.push(best.heard);
      // A tie the best guess cannot break goes to the value the other guesses say exactly; else none is taken
      // (three filters sound alike in "ইয়াল ফিল্ডার"; the others heard "ইয়ার ফিল্ডার", D158).
      const tied = found
        .filter((candidate) => best!.score - candidate.score < 0.05)
        .map(({ value }) => value);
      if (tied.length > 1) {
        const said = others.flatMap((other) =>
          near(other, [])
            .filter(({ exact }) => exact)
            .slice(0, 1),
        );
        const votes = tied.map((value) => said.filter((candidate) => candidate.value === value).length);
        const most = Math.max(...votes);
        if (!most || votes.filter((count) => count === most).length > 1) return null;
        best = { ...best, value: tied[votes.indexOf(most)]! };
        tiedSlots.set(concept, tied);
      }
      heardSlots.set(concept, best.value);
      return `${concept} ${best.value} (${best.score.toFixed(2)})`;
    })
    .filter(Boolean) as string[];
  candidates.push(...named.map((name) => `${name.kind} ${name.name}`));
  const saidYear = text ? parseYear(normalize(text, deps.dictionary.variants).tokens, { now }) : null;
  mark("candidates", since);

  const facts: Facts = { allowed: new AllowedFacts() };
  // The LLM tried to change the shop's data through the read tool ("সব কাস্টমার মুছে দাও" as DELETE): the guard refused
  // it, and the reply is the fixed help answer, never the LLM's own words, which once said it was deleting (D163).
  let changeRefused = false;
  facts.allowed.addFromText(text); // values the user said
  // A rack the user said, as an answer writes it: "সি ২" for "সি দুই" (D160).
  for (const rack of named.filter((name) => name.kind === "rack")) facts.allowed.addFromText(rack.name);
  if (state.context.vehicle?.year) facts.allowed.addNumber(state.context.vehicle.year);
  let questionsAsked = 0;
  const learned: TurnOutcome["learned"] = [];
  // Each name the LLM chose for a misheard word is a word that may be learned (D155): suggested to the owner once seen
  // twice, used only after the owner adds it.
  for (const { heard, option } of cleaned.replaced) {
    const words = learnableWords(heard, deps.dictionary);
    if (words) learned.push({ heard: words, concept: option.kind, value: option.value });
  }
  let final:
    | { kind: "answer"; text: string }
    | { kind: "question"; text: string; slot: string; offers: Offer[] }
    | { kind: "confirm"; text: string }
    | null = null;
  const role = deps.role ?? "staff";
  const offered = offeredWrites(deps.host.writes, role);
  // An app without a rack action: a rack goes in DokaanBondhu's own list, asked with Yes and No (D195, D199).
  if (
    deps.host.map &&
    deps.host.run &&
    !deps.host.writes?.capabilities.some((capability) => capability.template === "rack_update")
  )
    offered.push(ownRackCapability());
  const racks: TurnOutcome["racks"] = [];
  /** A waiting action's capability, by name, for the trace. */
  const capabilityName = (pending: PendingAction) =>
    deps.host.writes?.capabilities.find((item) => item.id === pending.capabilityId)?.name ?? "";
  const actions: ActionRecord[] = [];
  const added: AddedRecord[] = [];
  // A write said as an instruction ("…বাকিতে দাও", "joma nao", "kinlam"): the matching capability, which the turn
  // starts even when the model reaches for a search or a lookup first (D140).
  const cueKind = text
    ? writeCueOf(text, {
        partyNamed: named.some((name) => name.kind === "customer" || name.kind === "supplier"),
        supplierNamed: named.some((name) => name.kind === "supplier"),
      })
    : null;
  const cued = cueKind ? (offered.find((item) => item.template === cueKind) ?? null) : null;

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
      ...(result.kind === "rows" && result.cars
        ? {
            cars: result.cars.map((car) =>
              `${car.make}-${car.model}-${car.yearFrom}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            ),
          }
        : {}),
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
      const listed: Offer[] = result.options.map((option, index) => ({
        id: `opt-${index + 1}`,
        label: result.slot === "year" ? option.replace("-", "–") : option,
        // A year button is its car rows' years, so it picks exactly them (D167).
        value: option,
      }));
      const offers = listed.length ? listed : nearOffers(result.slot);
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
    if (result.resolved.vehicle) state.context.vehicle = rememberedCar(result.resolved);
    partsFacts(query, result);
    if (result.kind === "rows" && result.rows.length > LIST_KINDS) {
      const separated = separatingSlot(result.rows, tier, answeredSlots(frame));
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
  const completed = (
    query: PartQuery,
    answered: ReadonlySet<string> = new Set(),
    options: { carFromRequest?: boolean } = {},
  ): { query: PartQuery; remembered: Set<string> } => {
    const out = { ...query };
    // A fitment names the part's car and a second car: its part takes neither the request's car nor a year it did not
    // say (D172).
    const ownCar = options.carFromRequest === false;
    // A year answered to the year question, said or tapped, is the user's own like one said now: a tap says no words,
    // so D127's rule below once dropped the year just chosen and asked it again (D167).
    const answeredYear = answered.has("year") && Boolean(out.year);
    // The year the user said: in this input, or in the request an answer has just finished ("২০১৬ সালের নোয়া",
    // then "সেলফ").
    const ownYear = out.year ? parseYear(normalize(out.year).tokens, { now, bare: true }) : null;
    const said = ownCar
      ? ownYear !== null && saidNumbers(request).has(ownYear)
        ? ownYear
        : null
      : (saidYear ??
        (request === text ? null : parseYear(normalize(request, deps.dictionary.variants).tokens, { now })));
    if (
      out.year &&
      parseYear(normalize(out.year).tokens, { now, bare: true }) === null &&
      !parseYearRange(out.year)
    )
      delete out.year;
    if (!out.year && said !== null) out.year = String(said);
    for (const [slot, concept] of [
      ["part_type", "part_type"],
      ["vehicle", "vehicle_model"],
      ["position", "position"],
      ["quality", "quality"],
    ] as const) {
      const heard = ownCar && slot === "vehicle" ? undefined : heardSlots.get(concept);
      if (!out[slot] && heard) out[slot] = heard;
      // "ইয়াল ফিল্ডার" ties the air, oil and fuel filters; the other guesses heard "ইয়ার ফিল্ডার", so the LLM's
      // "মবিল ফিল্টার" gives way to the air filter (D158).
      const given = out[slot]
        ? matchConcept(concept, out[slot], [], deps.dictionary).candidates[0]?.value
        : null;
      if (heard && given && given !== heard && tiedSlots.get(concept)?.includes(given)) out[slot] = heard;
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
    // The remembered year: a year button's car years when it gave them (D167).
    const carYear = (remembered: NonNullable<typeof car>) =>
      remembered.years
        ? yearRangeText(remembered.years)
        : remembered.year === null
          ? null
          : String(remembered.year);
    if (car && !out.vehicle) {
      out.vehicle = car.model;
      remembered.add("vehicle");
      recall("year", carYear(car));
      recall("engine", car.engine);
    } else if (car && out.vehicle && sameCar(out.vehicle, car.model)) {
      if (said === null && !yearInside(out.vehicle)) {
        // The LLM copying the remembered first year ("ফিল্ডার ২০১২" in its context) gets the button's car years.
        const copied = out.year ? parseYear(normalize(out.year).tokens, { now, bare: true }) : null;
        if (car.years && !answeredYear && copied === car.year) delete out.year;
        recall("year", carYear(car));
      }
      recall("engine", car.engine);
    } else if (out.vehicle && out.year && said === null && !answeredYear) {
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
    host: deps.host.writes ?? NO_WRITES,
    dictionary: deps.dictionary,
    customers: deps.host.catalog.customers,
    suppliers: deps.host.catalog.suppliers.map((supplier) => ({
      hostId: supplier.hostId,
      name: supplier.name,
      nameBn: supplier.nameBn ?? null,
      attrs: supplier.attrs ?? {},
    })),
    appWords: deps.host.appWords ?? {},
    tier: billTier,
    mayPrice: role === "owner" || deps.staffPriceOverride === true,
    paikari: deps.host.paikari ?? null,
    // A rack as the shop writes its labels, and DokaanBondhu's own racks told from the app's (D195, D199).
    racks: rackLabels(deps.host.catalog),
    ownRacks: deps.host.rackExtra,
    // A fitment's car among the app's vehicles, and whether the fit is recorded already (D172).
    cars: (query) =>
      resolveCar({ query, catalog: deps.host.catalog, dictionary: deps.dictionary, hypotheses: others, now }),
    vehicles: deps.host.catalog.vehicles,
    ...(deps.host.map && deps.host.run
      ? {
          fits: (partId: string, vehicleId: string) =>
            fitRecorded({ map: deps.host.map!, run: deps.host.run! }, partId, vehicleId),
        }
      : {}),
    rememberedCustomer: state.context.customer
      ? { hostId: state.context.customer.hostId, name: state.context.customer.name }
      : null,
    now,
    newId: deps.newId,
    request: said,
    // The transcript before the clean-up step rewrote it (D153), when it did.
    ...(input.text && input.text.trim() !== text ? { heard: input.text.trim() } : {}),
    offersFor: nearOffers,
    // The car a write names is remembered like a search's (D125).
    // A return's sale, through the read path (D169).
    ...(deps.host.map && deps.host.run
      ? {
          sales: (input: { customerId: string | null; partId: string }) =>
            findSales({ map: deps.host.map!, run: deps.host.run! }, { ...input, now }),
          // A return's part from what its buyer bought (D186).
          bought: (customerId: string) =>
            boughtParts({ map: deps.host.map!, run: deps.host.run! }, { customerId, now }),
        }
      : {}),
    find: async (query) => {
      const result = await lookup(query);
      if (result.kind !== "ask" && result.resolved.vehicle)
        state.context.vehicle = rememberedCar(result.resolved);
      return result;
    },
    complete: completed,
    emit,
    ask,
  });

  /** A write step in this turn: a question (asked already), the confirmation, an answer, or the parts answer. */
  const tookStep = (frame: RequestFrame, step: WriteStep) => {
    state.frame = frame;
    // The customer of a write is remembered as soon as it is understood, like its car, with their price level (D119,
    // D125, D157): the memory line shows both while the write still asks the year or the quantity.
    const named = frame.slots.customer;
    const clear = (said: string) => {
      const match = resolveCustomer(said, [], deps.host.catalog.customers, deps.dictionary);
      const best = match.candidates[0];
      return match.decision === "understood" && best
        ? deps.host.catalog.customers.find((item) => item.hostId === best.customer.hostId)
        : undefined;
    };
    // Resolved already, or said clearly (the write may ask the car's year before it resolves the customer).
    const known = named?.hostId
      ? deps.host.catalog.customers.find((item) => item.hostId === named.hostId)
      : typeof named?.value === "string"
        ? clear(named.value)
        : undefined;
    if (known) {
      state.context.customer = {
        hostId: known.hostId,
        name: known.name,
        tier: customerTier(known.attrs, deps.host.appWords),
      };
    }
    if (step.kind === "asked") return;
    if (step.kind === "confirm") {
      frame.status = "confirming";
      renew(frame, now);
      state.action = step.action;
      if (deps.evalMode)
        trace.action = actionTrace(step.action, capabilityName(step.action), deps.host.catalog);
      actions.push({
        id: step.action.id,
        capabilityId: step.action.capabilityId,
        status: "pending",
        request: step.action.request,
        preview: step.action.preview,
        idempotencyKey: step.action.idempotencyKey,
      });
      // The sheet's customer, when the write took a remembered one rather than a named one (D119, D125).
      const customer = step.action.preview.customer;
      const sheetCustomer = customer
        ? deps.host.catalog.customers.find((item) => item.hostId === customer.hostId)
        : undefined;
      if (customer && sheetCustomer) {
        state.context.customer = {
          hostId: customer.hostId,
          name: sheetCustomer.name,
          tier: customerTier(sheetCustomer.attrs, deps.host.appWords),
        };
      }
      final = { kind: "confirm", text: step.text };
      return;
    }
    frame.status = "done";
    if (step.kind === "own_rack") {
      racks.push({ hostPartId: step.hostPartId, rack: step.rack });
      final = { kind: "answer", text: step.text };
      return;
    }
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
  /**
   * A write's one item without the part type, car, year, quality or side the request itself says: the request's own
   * words complete it, as they complete a part search (D118, D148). The model may leave one out.
   */
  const withHeardPart = (args: Record<string, unknown>): Record<string, unknown> => {
    const items = Array.isArray(args.items) ? args.items : null;
    const item = items?.length === 1 && items[0] && typeof items[0] === "object" ? items[0] : null;
    // A price change's or a fitment's one part, outside any items (D171, D172).
    const single =
      !items && args.part && typeof args.part === "object" ? (args.part as Record<string, unknown>) : null;
    if (!item && !single) return args;
    const line = { ...(item as Record<string, unknown> | null) };
    const part = { ...(single ?? (line.part as Record<string, unknown> | undefined) ?? {}) };
    const missing = (key: string) => part[key] === undefined || part[key] === null || part[key] === "";
    // A detail the model put beside the part rather than in it ("items": [{ "part_type": … }]) is the part's (D186).
    for (const key of ["part_type", "vehicle", "year", "position", "quality", "brand"]) {
      if (line[key] !== undefined && missing(key)) part[key] = line[key];
      delete line[key];
    }
    // What the user did not say is no detail: a quality only when one was heard, a part number only as said (D186).
    const inText = (value: unknown) =>
      ` ${normalize(text).tokens.join(" ")} `.includes(` ${normalize(String(value)).tokens.join(" ")} `);
    if (!missing("quality") && !heardSlots.has("quality") && !inText(part.quality)) delete part.quality;
    const spoken = asciiDigits(text)
      .replace(/[\s\-_./]/g, "")
      .toUpperCase();
    if (
      !missing("part_number") &&
      !spoken.includes(
        asciiDigits(String(part.part_number))
          .replace(/[\s\-_./]/g, "")
          .toUpperCase(),
      )
    )
      delete part.part_number;
    // A count said with its unit or টা ("ekta", "দুই সেট") is the line's quantity when the model left it out, or put
    // a number nobody said ("tinta …" as 1, D188).
    const unsaid = (value: unknown) => {
      if (value === undefined || value === null || value === "") return true;
      const number =
        parseQuantity(normalize(String(value)).tokens)?.value ?? Number(asciiDigits(String(value)));
      return !Number.isFinite(number) || !saidNumbers(text).has(number);
    };
    if (item && unsaid(line.quantity)) {
      const tokens = normalize(text, deps.dictionary.variants).tokens;
      const said = tokens
        .map((_, index) => parseQuantity(tokens.slice(index, index + 2)))
        .find((quantity) => quantity?.unit && quantity.value <= 1000);
      if (said) line.quantity = said.counted ? `${said.value}টা` : `${said.value} ${said.unit}`;
    }
    // A fitment's request names two cars, so its part takes neither the car nor the year from it (D172).
    const twoCars = Boolean(args.vehicle);
    for (const concept of ["part_type", "vehicle_model", "position", "quality"] as const) {
      if (twoCars && concept === "vehicle_model") continue;
      const key = concept === "vehicle_model" ? "vehicle" : concept;
      const heard = heardSlots.get(concept);
      if (heard && missing(key)) part[key] = heard;
    }
    if (saidYear && missing("year") && !twoCars) part.year = String(saidYear);
    return single ? { ...args, part } : { ...args, items: [{ ...line, part }] };
  };

  /**
   * A fitment's two cars as the request says them (D174): the car said with "also" (প্রিমিওতেও, premio teo) is the new
   * one, whether the model's call names it or not, and is never the part's own car, with the year said with it.
   */
  const withAlsoCar = (
    capability: WriteCapability,
    args: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (capability.template !== "add_fitment") return args;
    const words = alsoCarWords(said) ?? alsoCarWords(text);
    const carOf = (value: unknown) => {
      if (typeof value !== "string" || !value.trim()) return null;
      const best = matchConcept("vehicle_model", value, [], deps.dictionary).candidates[0];
      return best && best.score >= 0.7 ? best.value : null;
    };
    const also = words ? carOf(words) : null;
    if (!words || !also) return args;
    const year = parseYear(normalize(words).tokens, { now, bare: true });
    const part = { ...((args.part as Record<string, unknown> | undefined) ?? {}) };
    if (carOf(part.vehicle) === also) {
      delete part.vehicle;
      const partYear = parseYear(normalize(String(part.year ?? "")).tokens, { now, bare: true });
      if (year !== null && partYear === year) delete part.year;
    }
    const vehicle = args.vehicle;
    const model = typeof vehicle === "string" ? vehicle : (vehicle as { model?: unknown } | undefined)?.model;
    return {
      ...args,
      part,
      vehicle:
        carOf(model) === also ? vehicle : { model: also, ...(year !== null ? { year: String(year) } : {}) },
    };
  };

  /** The shop's own part number the request says, written however ("an 136 wk"), the longest one; null if none. */
  const numberSaid = (): string | null => {
    const squash = (value: string) =>
      asciiDigits(value)
        .replace(/[\s\-_./]/g, "")
        .toUpperCase();
    const spoken = squash(text);
    return (
      deps.host.catalog.parts
        .flatMap((part) => part.partNumbers)
        .filter((number) => squash(number).length >= 5 && spoken.includes(squash(number)))
        .sort((a, b) => squash(b).length - squash(a).length)[0] ?? null
    );
  };

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
    // A price change: the part, and the new price as said money, of the kind the request names (D171).
    const price = [...saidMoney(text)].at(-1);
    const heardPart = (withCar: boolean) =>
      Object.fromEntries(
        (["part_type", "vehicle_model", "position", "quality"] as const)
          .filter((concept) => heardSlots.has(concept) && (withCar || concept !== "vehicle_model"))
          .map((concept) => [concept === "vehicle_model" ? "vehicle" : concept, heardSlots.get(concept)]),
      );
    const args: Record<string, unknown> =
      capability.template === "add_customer" || capability.template === "add_supplier"
        ? { ...(customer ? { name: customer } : {}) }
        : // A fitment names two cars: its part takes none of them from the words (D172, D174).
          capability.template === "add_fitment"
          ? withAlsoCar(capability, { part: heardPart(false) })
          : capability.template === "rack_update"
            ? { part: { ...heardPart(true), ...part } }
            : capability.template === "price_update"
              ? {
                  part: {
                    ...heardPart(true),
                    ...part,
                  },
                  ...(price !== undefined
                    ? { prices: { [priceLevelIn(text) ?? "retail"]: String(price) } }
                    : {}),
                }
              : capability.template === "payment"
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
                          ...heardPart(true),
                          ...part,
                        },
                        // A count with টা is what the part is sold in, so it goes on as said (D186).
                        ...(quantity
                          ? {
                              quantity: quantity.counted
                                ? `${quantity.value}টা`
                                : `${quantity.value} ${quantity.unit}`,
                            }
                          : {}),
                        ...(unitCost !== null ? { unit_cost: String(unitCost) } : {}),
                      },
                    ],
                  };
    const frame = markGuessed(writeFrame(capability, args, writeTurn(text)));
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

  /** A reminder's list read from the app (D194), kept as a fact and shown as a table. */
  const remind = async (kind: ReminderKind): Promise<ReminderFacts> => {
    const read = { map: deps.host.map!, run: deps.host.run! };
    const reminder: ReminderFacts =
      kind === "low_stock"
        ? { kind, lines: await lowStock(read, deps.host.catalog, now) }
        : { kind, lines: await oldDues(read, deps.host.catalog, now) };
    (facts.reminders ??= []).push(reminder);
    for (const line of reminder.lines ?? []) {
      if ("old" in line) facts.allowed.addMoney(line.due).addMoney(line.old);
      else facts.allowed.addNumber(line.stock);
    }
    facts.allowed.addNumber(reminder.lines?.length ?? 0);
    const table = reminderTable(reminder, now);
    if (table) emit(table);
    return reminder;
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
        // A fitment's search names two cars, so its part is never taken from a search (D172).
        if (cued && !["payment", "add_fitment", "add_customer", "add_supplier"].includes(cued.template)) {
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
        // A part said by its number, read from the part's own tables only (no sale, purchase, payment or party):
        // the part search answers it, with its stock, price, rack and the cars the app records (D186, D188).
        const number = numberSaid();
        const sql = String(args.sql ?? "");
        const elsewhere = (
          ["Customer", "Sale", "SaleItem", "Return", "Payment", "Supplier", "Purchase"] as const
        )
          .map((concept) => deps.host.map?.entities[concept]?.hostTable)
          .filter((table): table is string => Boolean(table))
          .some((table) =>
            new RegExp(`\\b${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sql),
          );
        if (number && !cued && !elsewhere)
          return partsTool({ part_number: number }, (result) => record(`part_search: ${result}`));
        try {
          const result = await runReadQuery(deps.host.map, deps.host.run, sql);
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
          if (message === READ_ONLY_REFUSAL) {
            changeRefused = true;
            return "stop";
          }
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
          // The app's own reports when its feature list names them (D180).
          hostReports: deps.host.hostReports.length
            ? deps.host.hostReports
            : reportNamesOf(deps.host.writes?.features),
          ...(deps.host.writes
            ? { callHost: (report, from, to) => hostReport(deps.host.writes!, report, from, to) }
            : {}),
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
      case "get_reminders": {
        const kind = args.kind === "old_dues" ? "old_dues" : "low_stock";
        if (!deps.host.map || !deps.host.run) {
          record("no_connection");
          return JSON.stringify({ error: "no shop database connected" });
        }
        const reminder = await remind(kind);
        record(reminder.lines === null ? "see_in_app" : `rows:${reminder.lines.length}`);
        // The answer is the template's (counts, names only when few and in Bangla); the list is on the screen.
        return "stop";
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
        const offers = options.length
          ? options.map((option, index) => ({ id: `opt-${index + 1}`, label: option, value: option }))
          : nearOffers(slot);
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
        if (capability) {
          // The whole request: an answer to "which Rahim?" carries the request it answers, so the amount said
          // in it is still said (D186).
          const frame = markGuessed(
            writeFrame(capability, withHeardPart(withAlsoCar(capability, args)), writeTurn(request)),
          );
          record("write");
          tookStep(frame, await advanceWrite(frame, writeTurn(request)));
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
      // A new customer or supplier is known at once (D173); a sale or a stock-in that added it goes on with it.
      const record =
        result.status === "done" ? addedRecord(capability, pending.preview, result.response) : null;
      if (record) {
        added.push(record);
        const list =
          record.concept === "customer" ? deps.host.catalog.customers : deps.host.catalog.suppliers;
        list.push({ hostId: record.hostId, name: record.name, nameBn: null, attrs: record.attrs });
      }
      if (record && frame.slots.adding && frame.capabilityId !== capability.id) {
        clearAdding(frame);
        frame.slots[record.concept] = {
          value: record.name,
          display: record.name,
          hostId: record.hostId,
          status: "understood",
          source: "user",
        };
        frame.status = "active";
        renew(frame, now);
        tookStep(frame, await advanceWrite(frame, writeTurn(frame.request ?? text)));
        const next = final as { text: string } | null;
        if (next) next.text = `${result.text} ${next.text}`;
        else final = { kind: "answer", text: result.text };
      } else {
        frame.status = "done";
        state.frame = frame;
        final = { kind: "answer", text: result.text };
      }
    } else if (decision === "no" && frame.slots.adding && frame.capabilityId !== capability.id) {
      // No to a new name inside a sale or a stock-in: nothing is added, and its customer or supplier is asked again,
      // with the close names and the new-name button as before.
      cancel();
      const party = frame.slots.adding.value === "supplier" ? "supplier" : "customer";
      const heard = frame.slots.new_name?.value;
      clearAdding(frame);
      if (typeof heard === "string") frame.slots[party] = { value: heard, status: "unclear", source: "user" };
      frame.status = "active";
      renew(frame, now);
      tookStep(frame, await advanceWrite(frame, writeTurn(frame.request ?? text)));
      const next = final as { text: string } | null;
      const cancelled = resultText("cancelled", pending.preview.template);
      if (next) next.text = `${cancelled} ${next.text}`;
      else final = { kind: "answer", text: cancelled };
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
      if (deps.evalMode) trace.action = actionTrace(pending, capabilityName(pending), deps.host.catalog);
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
  // the LLM without it; "না, প্রিমিও" stays a correction (spec 9.3 rule 3, D127). The car must be in what was heard
  // best: one only among the speech service's other guesses ("দুই সেক্টর" for "দুই সেট", like Bajaj Discover) leaves
  // the answer to the question (D147).
  if (
    !final &&
    frameOpen &&
    state.frame &&
    state.frame.asking !== "vehicle" &&
    state.frame.asking !== "fit_vehicle" && // the car a fitment adds is answered with a car (D174)
    !splitCorrection(text).correction
  ) {
    // The transcript the turn works with, which the server may have chosen over the service's first guess.
    const best = text
      ? matchConcept("vehicle_model", text, [], deps.dictionary).candidates.find(
          (candidate) => !inName(candidate.heard),
        )
      : undefined;
    const heardCar = best && best.score >= 0.7 ? best.value : undefined;
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
      others,
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
    // A name asked again because it was heard unclearly, now answered: how it was heard may be learned (D155).
    if ((filled === "customer" || filled === "supplier") && frame.capabilityId) {
      const said = frame.slots[`said_${filled}`]?.value;
      const answer = frame.slots[filled];
      const people = filled === "customer" ? deps.host.catalog.customers : deps.host.catalog.suppliers;
      const person = people.find(
        (candidate) =>
          candidate.hostId === answer?.hostId ||
          candidate.hostId === answer?.value ||
          candidate.name === answer?.value,
      );
      const words = typeof said === "string" ? learnableWords(said, deps.dictionary) : null;
      if (person && words) learned.push({ heard: words, concept: filled, value: person.name });
      // The new-name button adds the name as heard (D173).
      if (answer?.value !== NEW_PARTY) delete frame.slots[`said_${filled}`];
    }
    if (
      (filled || correction) &&
      frame.capabilityId &&
      (deps.host.writes || frame.capabilityId === OWN_RACK_ID)
    ) {
      // A write's answer, or "না, X" for a part detail: the write goes on from where it was (spec 9.3 rule 3).
      if (correction) {
        frame.slots[correction.slot] = { value: correction.value, status: "understood", source: "user" };
        carChanged(frame, correction.slot);
        delete frame.slots.part;
        delete frame.slots.part_pick;
      }
      renew(frame, now);
      tookStep(frame, await advanceWrite(frame, writeTurn(frame.request ?? text)));
    }
    if (correction && frame.intent === "find_parts") {
      frame.slots[correction.slot] = { value: correction.value, status: "understood", source: "user" };
      carChanged(frame, correction.slot);
    }
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

  // A write only the owner may make, asked by staff (a price change, D171): refused at once, and nothing changes.
  const ownersOnly =
    cueKind && !cued && !final
      ? deps.host.writes?.capabilities.find(
          (capability) =>
            capability.template === cueKind && capability.requiredRole === "owner" && role !== "owner",
        )
      : undefined;
  if (ownersOnly) {
    trace.tool_calls.push({ name: ownersOnly.name, arguments: {}, result: "owner_only" });
    final = { kind: "answer", text: ownerOnlyText(ownersOnly.template) };
  }

  // A clear reminder question ("কী কী কম আছে?", "kar baki purono?") is answered at once, without the LLM (D194). One
  // that names a part, a car or a customer is about that one, and goes on as before.
  const reminderCue =
    text && !final && !facts.parts && !facts.report && !cueKind && deps.host.map && deps.host.run
      ? reminderCueOf(text)
      : null;
  if (
    reminderCue &&
    !heardSlots.has("part_type") &&
    !heardSlots.has("vehicle_model") &&
    !named.some((name) => name.kind === "customer" || name.kind === "supplier")
  ) {
    const reminder = await remind(reminderCue);
    trace.tool_calls.push({
      name: "get_reminders",
      arguments: { kind: reminderCue },
      result: reminder.lines === null ? "see_in_app" : `rows:${reminder.lines.length}`,
    });
  }

  // Stage 5: the LLM tool loop, unless the frame already has the reply or the facts.
  let llmText: string | null = null;
  const needLlm = !final && !facts.parts && !facts.report && !facts.reminders && request;
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
        // Voice: the speech-to-text's other guesses too, so the LLM can read a misheard word (D153).
        content: `${request}${candidates.length ? `\n(candidates: ${candidates.join("; ")})` : ""}${
          others.length ? `\n(also heard as: ${others.slice(0, 3).join(" | ")})` : ""
        }${cued ? `\n(this asks to record it: call ${cued.name})` : ""}`,
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
        let phrasing = await collect(deps.llm, messages, [], note);
        trace.llm_calls++;
        // Asked to phrase, the model wrote one more read as text ("which cars" after finding the part by its
        // number): that read runs, and the model phrases both (D188).
        const more = phrasing.calls.filter((call) => call.name === "run_read_query").slice(0, 1);
        if (more.length && trace.llm_calls < LLM_CALLS) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: more.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          });
          const result = await runTool(more[0]!);
          if (result !== "stop" && !final) {
            messages.push(
              {
                role: "tool",
                tool_call_id: more[0]!.id,
                content: `<tool_result name="${more[0]!.name}">${result}</tool_result>`,
              },
              { role: "user", content: PHRASING },
            );
            phrasing = await collect(deps.llm, messages, [], note);
            trace.llm_calls++;
          }
        }
        llmText = phrasing.text;
      }
    } catch (error) {
      if (!(error instanceof NothingLeftError)) throw error;
      llmText = null; // the provider chain is out: the template answer for the facts we have
      if (!facts.parts && !facts.read && !facts.report && !facts.reminders && !final)
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
  } else if (facts.reminders) {
    // Counts and names from the lists themselves, never the LLM's words (D194).
    reply = templateAnswer(facts);
    state.state = "RESPONDING";
  } else {
    state.state = "RESPONDING";
    const template = templateAnswer(facts);
    if (changeRefused) {
      reply = helpAnswer();
    } else if (llmText && trace.tool_calls.length === 0) {
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

  // An offline-first app whose phones last synced long ago: a read answer says how old its figures are (D181).
  if (
    state.state === "RESPONDING" &&
    !final &&
    (facts.parts || facts.read || facts.report?.kind === "figure" || facts.reminders?.some((r) => r.lines)) &&
    deps.host.writes
  ) {
    const note = await syncNote(deps.host.writes, deps.now());
    if (note) reply = `${reply} ${note}`;
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
    added,
    racks,
  };
}

export { banglaOf };
