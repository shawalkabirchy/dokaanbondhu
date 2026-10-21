import { asciiDigits, factsIn, normalize, SEE_IN_APP } from "@dokaanbondhu/core";
import type { Item, LookupExpected, MustNotExpected, ReadExpected, WriteExpected } from "./items";

// The scorer (spec 18.4; architecture 11.2): correct action, exact part after clarification, questions per item, the
// zero rules and latency medians, per channel and split, per kind, and per writing style of the chat items (D96).
// Pure functions over what the runner recorded, so a run can be
// scored again without the server.

/** What the done event's trace carries in evaluation mode (the engine's TurnTrace). */
export interface Trace {
  tool_calls: { name: string; arguments: unknown; result: string }[];
  lookups: {
    resolved: {
      part_type: string | null;
      vehicle: string | null;
      year: number | null;
      position: string | null;
      quality: string | null;
      brand?: string | null;
    };
    result: "rows" | "none" | "ask";
    parts: string[][];
    /** A part found by its number: the cars it is recorded for, as make-model-year (D186). */
    cars?: string[];
  }[];
  questions: string[];
  answer: string;
  grounding_failures: number;
  llm_calls: number;
  fallbacks: string[];
  /** An action put on the Yes/No sheet: what it would save (the engine's ActionTrace, D185). */
  action?: ActionTrace;
}

export interface ActionTrace {
  capability: string;
  template: string;
  customer: string | null;
  supplier: string | null;
  new_party: { name: string; type: string | null; phone: string | null } | null;
  lines: { part_numbers: string[]; quantity: number }[];
  parts: string[][];
  vehicle: { model: string; year_from: number } | null;
  total: number | null;
  paid: number;
  request: { method: string; path: string; body: unknown };
}

export interface TableRecord {
  columns: { key: string; kind: string }[];
  rows: (string | number | null)[][];
}

export interface TurnRecord {
  sent: string;
  reply: string;
  state: string;
  /** The slot a question asked about (from its chips or the trace), when the turn ended with a question. */
  slot: string | null;
  trace: Trace | null;
  tables: TableRecord[];
  cards: number;
  errors: string[];
  firstTextMs: number | null;
  totalMs: number;
  /** Voice turns: what the speech model heard, when the first audio came, and the server's stage timings. */
  transcript?: string;
  firstAudioMs?: number | null;
  timings?: Record<string, number>;
  /** A turn the runner sent with the sheet's buttons: its Yes or No, or the Undo after it. */
  kind?: "decision" | "undo";
  /** The action the turn put on a Yes/No sheet. */
  confirmId?: string;
  /** What became of an action in this turn. */
  actionResult?: { status: "done" | "failed" | "review" | "cancelled"; undoAvailable: boolean };
}

export interface ItemResult {
  id: string;
  status: "done" | "not_built" | "skipped" | "error";
  reason?: string;
  turns: TurnRecord[];
  /** Questions answered "I don't know" because the script had no answer: each is unnecessary. */
  unscripted: number;
  /** A saved write: whether it was undone again, so the next items see the data as seeded. */
  undone?: boolean;
}

export interface ItemScore {
  id: string;
  channel: string;
  split: string;
  kind: string;
  /** Chat items: "bangla" or "banglish"; voice items: null. */
  style: string | null;
  scored: boolean;
  correct: boolean;
  exactPart: boolean | null;
  questions: number;
  unnecessary: number;
  zeroRules: string[];
  firstTextMs: number | null;
  totalMs: number | null;
  /** Voice items with a reference transcript: word errors of the first transcript against it (D64). */
  wer: { errors: number; words: number } | null;
  notes: string[];
}

const same = (a: unknown, b: unknown) =>
  String(a ?? "")
    .trim()
    .toLowerCase() ===
  String(b ?? "")
    .trim()
    .toLowerCase();

/** A part number compared without spaces, dashes or case (04465-10010 = 0446510010). */
export const partKey = (value: string) =>
  asciiDigits(value)
    .replace(/[\s\-_./]/g, "")
    .toUpperCase();

/** The action the item put on a Yes/No sheet last, if any. */
const prepared = (result: ItemResult) =>
  result.turns.flatMap((turn) => (turn.trace?.action ? [turn.trace.action] : [])).at(-1);

/** A name as written, without case, spaces or marks; Bangla letters kept. */
const nameKey = (value: unknown) =>
  asciiDigits(String(value ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]/g, "");

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The same name, allowing a letter or two as speech writes it ("Al-Amin Auto Garage" = "alamin auto garage"). */
export function sameName(said: unknown, ...expected: unknown[]): boolean {
  const key = nameKey(said);
  if (!key) return false;
  return expected.some((value) => {
    const want = nameKey(value);
    return want !== "" && (key === want || editDistance(key, want) <= Math.floor(want.length / 8));
  });
}

/** Every leaf of a request body, with the key it sits under. */
function leaves(node: unknown, key = ""): { key: string; value: unknown }[] {
  if (Array.isArray(node)) return node.flatMap((child) => leaves(child, key));
  if (node && typeof node === "object")
    return Object.entries(node).flatMap(([child, value]) => leaves(value, child));
  return [{ key, value: node }];
}

/** Whether the action on the sheet is the item's, with every slot it names. */
export function writeMatches(expected: WriteExpected, action: ActionTrace, notes: string[]): boolean {
  const slots = (expected.slots ?? {}) as Record<string, unknown>;
  let ok = true;
  const check = (good: boolean, note: string) => {
    if (!good) {
      ok = false;
      notes.push(note);
    }
  };
  const body = leaves(action.request.body);
  const keyed = (pattern: RegExp, value: unknown) =>
    body.some((leaf) => pattern.test(leaf.key) && Number(leaf.value) === Number(value));
  const carries = (value: unknown) =>
    body.some((leaf) => String(leaf.value ?? "").toLowerCase() === String(value).toLowerCase());
  const quantity = action.lines[0]?.quantity;
  check(action.template === expected.action, `action ${action.template}, not ${expected.action}`);
  if (expected.part_key) {
    const numbers = [...action.lines.map((line) => line.part_numbers), ...action.parts];
    const key = partKey(expected.part_key);
    check(
      numbers.some((list) => list.some((number) => partKey(number) === key)),
      `part ${expected.part_key} not on the sheet`,
    );
  }
  const saleRef = slots.sale_ref as { customer?: string } | undefined;
  const customer = slots.customer ?? saleRef?.customer;
  if (customer) check(sameName(action.customer, customer), `customer ${action.customer}, not ${customer}`);
  if (slots.supplier)
    check(sameName(action.supplier, slots.supplier), `supplier ${action.supplier}, not ${slots.supplier}`);
  if (slots.quantity !== undefined)
    check(quantity === slots.quantity, `quantity ${quantity}, not ${slots.quantity}`);
  if (slots.payment === "due") check(action.paid === 0, `paid ${action.paid}, not on credit`);
  else if (slots.payment)
    check(action.paid > 0 && carries(slots.payment), `not paid by ${slots.payment} (paid ${action.paid})`);
  if (slots.method) check(carries(slots.method), `method not ${slots.method}`);
  if (slots.amount !== undefined)
    check(action.paid === slots.amount || keyed(/amount/i, slots.amount), `amount not ${slots.amount}`);
  if (slots.unit_price !== undefined)
    check(
      keyed(/price/i, slots.unit_price) ||
        (quantity !== undefined && action.total === Number(slots.unit_price) * quantity),
      `price not ${slots.unit_price} each (total ${action.total})`,
    );
  if (slots.unit_cost !== undefined)
    check(keyed(/cost/i, slots.unit_cost), `cost not ${slots.unit_cost} each`);
  const prices = slots.prices as Record<string, number> | undefined;
  for (const [level, value] of Object.entries(prices ?? {}))
    check(
      keyed(level === "retail" ? /retail/i : /garage|wholesale|paikari|trade/i, value),
      `${level} price not ${value}`,
    );
  const vehicle = slots.vehicle as { model: string; year: number } | undefined;
  if (vehicle)
    check(
      sameName(action.vehicle?.model, vehicle.model) && action.vehicle?.year_from === vehicle.year,
      `car ${action.vehicle?.model ?? "none"} ${action.vehicle?.year_from ?? ""}, not ${vehicle.model} ${vehicle.year}`,
    );
  if (slots.name)
    check(
      sameName(action.new_party?.name, slots.name, slots.name_bn),
      `name ${action.new_party?.name ?? "none"}, not ${slots.name}`,
    );
  if (slots.party_type)
    check(
      same(action.new_party?.type, slots.party_type) || carries(slots.party_type),
      `type ${action.new_party?.type ?? "none"}, not ${slots.party_type}`,
    );
  if (slots.phone) {
    const digits = (value: unknown) => asciiDigits(String(value ?? "")).replace(/\D/g, "");
    const phone = digits(slots.phone);
    check(
      digits(action.new_party?.phone) === phone || body.some((leaf) => digits(leaf.value) === phone),
      `phone not ${slots.phone}`,
    );
  }
  return ok;
}

function lookups(result: ItemResult) {
  return result.turns.flatMap((turn) => turn.trace?.lookups ?? []);
}

/** Everything the user was shown: the reply text and every table cell (money cells read as whole taka). */
function shown(result: ItemResult): { text: string; numbers: Set<string>; rows: number } {
  const texts: string[] = [];
  const numbers = new Set<string>();
  let rows = 0;
  for (const turn of result.turns) {
    texts.push(turn.reply);
    for (const number of factsIn(turn.reply).numbers) numbers.add(number);
    for (const table of turn.tables) {
      rows += table.rows.length;
      for (const row of table.rows) {
        row.forEach((cell, index) => {
          if (cell === null) return;
          const kind = table.columns[index]?.kind;
          if (typeof cell === "number") {
            // Every number as it is: money cells are whole taka (D110), like the money in the text.
            numbers.add(String(kind === "money" ? Math.round(cell) : cell));
          } else {
            texts.push(cell);
            for (const number of factsIn(cell).numbers) numbers.add(number);
          }
        });
      }
    }
  }
  return { text: asciiDigits(texts.join("\n")), numbers, rows };
}

/** The cars of the last part found by its number, when the trace has them. */
const carsTraced = (result: ItemResult) =>
  result.turns
    .flatMap((turn) => turn.trace?.lookups ?? [])
    .map((lookup) => lookup.cars)
    .filter((cars): cars is string[] => Array.isArray(cars))
    .at(-1);

function readAnswered(expected: ReadExpected, result: ItemResult, notes: string[]): boolean {
  const { text, numbers, rows } = shown(result);
  if (expected.answer === "see_in_app") {
    const ok = result.turns.some((turn) => turn.reply.includes(SEE_IN_APP));
    if (!ok) notes.push("not sent to the app");
    return ok;
  }
  let ok = true;
  for (const [key, value] of Object.entries(expected.answer)) {
    if (key.endsWith("_taka") && typeof value === "number") {
      if (!numbers.has(String(value))) {
        ok = false;
        notes.push(`${key} ${value} not shown`);
      }
    } else if (key === "phone" && typeof value === "string") {
      if (!text.includes(value)) {
        ok = false;
        notes.push(`phone ${value} not shown`);
      }
    } else if (key === "vehicles" && Array.isArray(value) && carsTraced(result)) {
      // Which cars a part fits: the cars the answer was made from, against the expected ones (D186).
      const cars = carsTraced(result)!;
      const want = new Set(value.map(String));
      if (cars.length !== want.size || !cars.every((car) => want.has(car))) {
        ok = false;
        notes.push(`cars ${cars.join(", ") || "none"}, not ${[...want].join(", ")}`);
      }
    } else if (Array.isArray(value)) {
      // A list: every key named, or a table with exactly that many rows.
      const named = value.every((entry) =>
        typeof entry === "string" ? partKey(text).includes(partKey(entry)) : false,
      );
      if (!named && rows !== value.length) {
        ok = false;
        notes.push(`${key}: ${value.length} expected, ${rows} rows shown`);
      }
    }
  }
  return ok;
}

export function scoreItem(item: Item, result: ItemResult): ItemScore {
  const notes: string[] = [];
  const zeroRules: string[] = [];
  const base = {
    id: item.id,
    channel: item.channel,
    split: item.split,
    kind: item.kind,
    style: item.script_style ?? null,
    questions: result.turns.filter((turn) => turn.state === "CLARIFYING").length,
    unnecessary: result.unscripted,
    firstTextMs: result.turns[0]?.firstTextMs ?? null,
    totalMs: result.turns[0]?.totalMs ?? null,
    wer:
      item.channel === "voice" && item.reference_transcript && result.turns[0]?.transcript !== undefined
        ? wordErrors(item.reference_transcript, result.turns[0].transcript)
        : null,
  };
  if (result.status !== "done") {
    return {
      ...base,
      scored: false,
      correct: false,
      exactPart: null,
      zeroRules,
      notes: [result.reason ?? result.status],
    };
  }
  // Zero rule 1: a write saved without the user's yes. The runner says yes only on the sheet, so anything saved in
  // another turn was saved without it.
  const unconfirmed = result.turns.filter(
    (turn) =>
      turn.kind !== "decision" &&
      turn.kind !== "undo" &&
      (turn.actionResult?.status === "done" || turn.actionResult?.status === "review"),
  );
  if (unconfirmed.length) zeroRules.push(`action saved without confirmation (${unconfirmed.length})`);
  // Any action put on a sheet: right only for a write item.
  const action = prepared(result);
  const acted = action !== undefined || unconfirmed.length > 0;

  let correct: boolean;
  let exactPart: boolean | null = null;
  if (item.kind === "part_lookup") {
    const expected = item.expected as LookupExpected;
    const final = lookups(result)
      .filter((lookup) => lookup.result !== "ask")
      .at(-1);
    if (!final) notes.push("no part lookup");
    const resolved = final?.resolved;
    const params = expected.params;
    // Each expected parameter must be understood as expected; a part number alone is judged by the part found.
    exactPart =
      final?.result === "rows" &&
      final.parts.some((numbers) => numbers.some((number) => partKey(number) === partKey(expected.part_key)));
    // A quality the card leaves out may be answered by listing every quality with the expected part among them,
    // instead of asking (the owner's rule, D186); a brand the card names is right when its part is the one found.
    const listedQualities = item.script.quality !== undefined && exactPart;
    const matches =
      !!resolved &&
      (params.part_type === undefined || same(resolved.part_type, params.part_type)) &&
      (params.vehicle === undefined || same(resolved.vehicle, params.vehicle)) &&
      (params.year === undefined || resolved.year === params.year) &&
      (params.position === undefined || same(resolved.position, params.position)) &&
      (params.quality === undefined || same(resolved.quality, params.quality) || listedQualities) &&
      (params.brand === undefined || same(resolved.brand, params.brand) || exactPart);
    if (final && !matches) notes.push(`understood ${JSON.stringify(resolved)}`);
    if (final && !exactPart) notes.push(`part ${expected.part_key} not found (${final.result})`);
    correct = matches && (params.part_number === undefined || exactPart) && !acted;
  } else if (item.kind === "other_read") {
    correct = readAnswered(item.expected as ReadExpected, result, notes) && !acted;
  } else if (item.kind === "must_not_act") {
    const expected = item.expected as MustNotExpected;
    // Zero rule 2: an answer that asserts fitment not in the data (parts found for the car the item names).
    if (item.subkind === "no_recorded_fitment" && expected.part_key) {
      const asserted = lookups(result).some(
        (lookup) =>
          lookup.result === "rows" &&
          (!expected.vehicle || same(lookup.resolved.vehicle, expected.vehicle)) &&
          lookup.parts.some((numbers) =>
            numbers.some((number) => partKey(number) === partKey(expected.part_key!)),
          ),
      );
      if (asserted) zeroRules.push("fitment asserted that is not in the data");
    }
    if (action) notes.push(`put ${action.template} on a sheet`);
    correct = !acted && zeroRules.length === 0;
  } else {
    // A write: the item's action on the sheet with every slot, saved on the runner's yes, and undone after.
    const expected = item.expected as WriteExpected;
    const decision = result.turns.find((turn) => turn.kind === "decision");
    if (!action) notes.push("no action on a sheet");
    const matches = action ? writeMatches(expected, action, notes) : false;
    const saved = decision?.actionResult?.status === "done";
    if (action && !saved) notes.push(`not saved: ${decision?.actionResult?.status ?? "no answer"}`);
    if (expected.part_key && action) {
      const key = partKey(expected.part_key);
      exactPart = [...action.lines.map((line) => line.part_numbers), ...action.parts].some((list) =>
        list.some((number) => partKey(number) === key),
      );
    }
    if (result.undone === false) notes.push("not undone: reset the test shop before the next run");
    correct = matches && saved && zeroRules.length === 0;
  }
  return { ...base, scored: true, correct, exactPart, zeroRules, notes };
}

export interface GroupReport {
  items: number;
  scored: number;
  correct: number;
  correctRate: number | null;
  exactPart: number;
  exactPartOf: number;
  exactPartRate: number | null;
  questionsPerItem: number | null;
  unnecessaryQuestions: number;
  zeroRuleViolations: number;
  medianFirstTextMs: number | null;
  medianTotalMs: number | null;
  /** The speech model's word error rate over the voice items with a reference transcript (D64). */
  werRate: number | null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

export function groupReport(scores: ItemScore[]): GroupReport {
  const scored = scores.filter((score) => score.scored);
  const withPart = scored.filter((score) => score.exactPart !== null);
  const correct = scored.filter((score) => score.correct).length;
  const exact = withPart.filter((score) => score.exactPart).length;
  return {
    items: scores.length,
    scored: scored.length,
    correct,
    correctRate: rate(correct, scored.length),
    exactPart: exact,
    exactPartOf: withPart.length,
    exactPartRate: rate(exact, withPart.length),
    questionsPerItem: scored.length
      ? Math.round((scored.reduce((sum, score) => sum + score.questions, 0) / scored.length) * 100) / 100
      : null,
    unnecessaryQuestions: scored.reduce((sum, score) => sum + score.unnecessary, 0),
    zeroRuleViolations: scored.reduce((sum, score) => sum + score.zeroRules.length, 0),
    medianFirstTextMs: median(
      scored.flatMap((score) => (score.firstTextMs === null ? [] : [score.firstTextMs])),
    ),
    medianTotalMs: median(scored.flatMap((score) => (score.totalMs === null ? [] : [score.totalMs]))),
    werRate: (() => {
      const measured = scores.flatMap((score) => (score.wer ? [score.wer] : []));
      const words = measured.reduce((sum, wer) => sum + wer.words, 0);
      return rate(
        measured.reduce((sum, wer) => sum + wer.errors, 0),
        words,
      );
    })(),
  };
}

export interface Report {
  runId: string;
  /** The providers that answered, from GET /me at the start of the run (D98), e.g. chat: cloudflare -> deepseek. */
  providers: { chat: string[]; stt: string | null; tts: string | null } | null;
  groups: Record<string, GroupReport>;
  byKind: Record<string, GroupReport>;
  /** Chat items by how they are written, overall and per split: Bangla script against Banglish (D96). */
  byStyle: Record<string, GroupReport>;
  zeroRules: { id: string; rule: string }[];
  notScored: { id: string; reason: string }[];
  failures: { id: string; kind: string; notes: string[] }[];
  scores: ItemScore[];
}

export function buildReport(
  runId: string,
  scores: ItemScore[],
  providers: Report["providers"] = null,
): Report {
  const groupBy = (key: (score: ItemScore) => string, among = scores) => {
    const groups = new Map<string, ItemScore[]>();
    for (const score of among) groups.set(key(score), [...(groups.get(key(score)) ?? []), score]);
    return Object.fromEntries(
      [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, groupReport(v)]),
    );
  };
  const chat = scores.filter((score) => score.style);
  return {
    runId,
    providers,
    groups: { ...groupBy((score) => `${score.channel} ${score.split}`), all: groupReport(scores) },
    byKind: groupBy((score) => score.kind),
    byStyle: {
      ...groupBy((score) => score.style!, chat),
      ...groupBy((score) => `${score.style} ${score.split}`, chat),
    },
    zeroRules: scores.flatMap((score) => score.zeroRules.map((rule) => ({ id: score.id, rule }))),
    notScored: scores
      .filter((score) => !score.scored)
      .map((score) => ({ id: score.id, reason: score.notes[0] ?? "" })),
    failures: scores
      .filter((score) => score.scored && !score.correct)
      .map((score) => ({ id: score.id, kind: score.kind, notes: score.notes })),
    scores,
  };
}

export function renderMarkdown(report: Report): string {
  const cell = (value: number | null, suffix = "") => (value === null ? "–" : `${value}${suffix}`);
  const table = (groups: Record<string, GroupReport>) => [
    "| Group | Items | Scored | Correct action | Exact part | Questions/item | Unnecessary | Zero rules | First text (median) | Total (median) | Speech WER |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(groups).map(
      ([name, g]) =>
        `| ${name} | ${g.items} | ${g.scored} | ${cell(g.correctRate, "%")} (${g.correct}) | ${cell(g.exactPartRate, "%")} (${g.exactPart}/${g.exactPartOf}) | ${cell(g.questionsPerItem)} | ${g.unnecessaryQuestions} | ${g.zeroRuleViolations} | ${cell(g.medianFirstTextMs, " ms")} | ${cell(g.medianTotalMs, " ms")} | ${cell(g.werRate, "%")} |`,
    ),
  ];
  const lines = [
    `# Evaluation run ${report.runId}`,
    "",
    report.providers
      ? `Models in use: chat ${report.providers.chat.join(" -> ") || "none"}; speech-to-text ${report.providers.stt ?? "none"}; text-to-speech ${report.providers.tts ?? "none"} (evaluation turns always use our own speech models, D98).`
      : "Models in use: not recorded for this run.",
    "",
    report.zeroRules.length
      ? `**Zero rules broken: ${report.zeroRules.length}. The evaluation fails whatever the accuracy.**`
      : "No zero rule broken (no write without confirmation, no fitment asserted that is not in the data).",
    "",
    "## By channel and split",
    "",
    ...table(report.groups),
    "",
    "## By kind of request",
    "",
    ...table(report.byKind),
    "",
  ];
  if (Object.keys(report.byStyle).length) {
    lines.push("## Chat by writing style (Bangla script, Banglish)", "", ...table(report.byStyle), "");
  }
  if (report.zeroRules.length) {
    lines.push("## Zero rules", "", ...report.zeroRules.map((z) => `- ${z.id}: ${z.rule}`), "");
  }
  if (report.failures.length) {
    lines.push(
      "## Not correct",
      "",
      ...report.failures.map((f) => `- ${f.id} (${f.kind}): ${f.notes.join("; ")}`),
      "",
    );
  }
  if (report.notScored.length) {
    lines.push("## Not scored", "", ...report.notScored.map((n) => `- ${n.id}: ${n.reason}`), "");
  }
  return lines.join("\n");
}

/** Word errors (substitutions, insertions, deletions) of a transcript against its reference, on normalized words. */
export function wordErrors(reference: string, heard: string): { errors: number; words: number } {
  const ref = normalize(reference).tokens;
  const hyp = normalize(heard).tokens;
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return { errors: previous[hyp.length]!, words: ref.length };
}
