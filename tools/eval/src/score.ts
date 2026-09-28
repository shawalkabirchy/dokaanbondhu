import { asciiDigits, factsIn, SEE_IN_APP } from "@dokaanbondhu/core";
import type { Item, LookupExpected, MustNotExpected, ReadExpected } from "./items";

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
  }[];
  questions: string[];
  answer: string;
  grounding_failures: number;
  llm_calls: number;
  fallbacks: string[];
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
}

export interface ItemResult {
  id: string;
  status: "done" | "not_built" | "skipped" | "error";
  reason?: string;
  turns: TurnRecord[];
  /** Questions answered "I don't know" because the script had no answer: each is unnecessary. */
  unscripted: number;
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
  notes: string[];
}

/** The read tools; any other tool is an action (a write). */
const READ_TOOLS = new Set(["find_parts", "run_read_query", "get_report", "resolve_customer", "ask_user"]);

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

function toolCalls(result: ItemResult) {
  return result.turns.flatMap((turn) => turn.trace?.tool_calls ?? []);
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
            numbers.add(String(kind === "money" ? Math.round(cell / 100) : cell));
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
  const actions = toolCalls(result).filter((call) => !READ_TOOLS.has(call.name));
  // Zero rule 1: a write without confirmation. Writes come with step 5; until then any action is one.
  if (actions.length)
    zeroRules.push(`action without confirmation: ${actions.map((call) => call.name).join(", ")}`);

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
    const matches =
      !!resolved &&
      (params.part_type === undefined || same(resolved.part_type, params.part_type)) &&
      (params.vehicle === undefined || same(resolved.vehicle, params.vehicle)) &&
      (params.year === undefined || resolved.year === params.year) &&
      (params.position === undefined || same(resolved.position, params.position)) &&
      (params.quality === undefined || same(resolved.quality, params.quality)) &&
      (params.brand === undefined || same(resolved.brand, params.brand));
    if (final && !matches) notes.push(`understood ${JSON.stringify(resolved)}`);
    exactPart =
      final?.result === "rows" &&
      final.parts.some((numbers) => numbers.some((number) => partKey(number) === partKey(expected.part_key)));
    if (final && !exactPart) notes.push(`part ${expected.part_key} not found (${final.result})`);
    correct = matches && (params.part_number === undefined || exactPart) && actions.length === 0;
  } else if (item.kind === "other_read") {
    correct = readAnswered(item.expected as ReadExpected, result, notes) && actions.length === 0;
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
    correct = actions.length === 0 && zeroRules.length === 0;
  } else {
    notes.push("writes are scored from step 5");
    return { ...base, scored: false, correct: false, exactPart: null, zeroRules, notes };
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
  };
}

export interface Report {
  runId: string;
  groups: Record<string, GroupReport>;
  byKind: Record<string, GroupReport>;
  /** Chat items by how they are written, overall and per split: Bangla script against Banglish (D96). */
  byStyle: Record<string, GroupReport>;
  zeroRules: { id: string; rule: string }[];
  notScored: { id: string; reason: string }[];
  failures: { id: string; kind: string; notes: string[] }[];
  scores: ItemScore[];
}

export function buildReport(runId: string, scores: ItemScore[]): Report {
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
    "| Group | Items | Scored | Correct action | Exact part | Questions/item | Unnecessary | Zero rules | First text (median) | Total (median) |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...Object.entries(groups).map(
      ([name, g]) =>
        `| ${name} | ${g.items} | ${g.scored} | ${cell(g.correctRate, "%")} (${g.correct}) | ${cell(g.exactPartRate, "%")} (${g.exactPart}/${g.exactPartOf}) | ${cell(g.questionsPerItem)} | ${g.unnecessaryQuestions} | ${g.zeroRuleViolations} | ${cell(g.medianFirstTextMs, " ms")} | ${cell(g.medianTotalMs, " ms")} |`,
    ),
  ];
  const lines = [
    `# Evaluation run ${report.runId}`,
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
