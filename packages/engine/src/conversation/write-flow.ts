import {
  banglaOf,
  checkQuantity,
  confirmationText,
  dayText,
  daysAgoSaid,
  daysBefore,
  levelPrice,
  methodText,
  money,
  normalize,
  parseAmount,
  parseQuantity,
  paymentText,
  possessive,
  priceLevelIn,
  question,
  quantity as quantityText,
  refundText,
  resolveCustomer,
  resultText,
  saidMoney,
  saidNumbers,
  saysCredit,
  saysDamaged,
  separatingSlot,
  slotChips,
  type ActionFields,
  type ActionLine,
  type CatalogCustomer,
  type Dictionary,
  type PartRow,
  type PriceLevel,
  type QuestionInput,
  type QuestionSlot,
  type SaidQuantity,
  unitWord,
  WALK_IN,
  year as yearText,
} from "@dokaanbondhu/core";
import type { ReplyEvent } from "@dokaanbondhu/contracts";
import { HostCallFailed, WAKE_WAIT_MS } from "../host/api";
import type { FindPartsResult, PartQuery } from "../host/find-parts";
import {
  answerFacts,
  buildBody,
  cashMethod,
  dryRunQuery,
  leafOf,
  methodParam,
  refundOf,
  refusalOf,
  requestPath,
  takesDamaged,
  takesPaikari,
  writeSlots,
  type ResolvedWrite,
} from "../write/request";
import type { FoundSales, SaleLine } from "../write/sale-finder";
import type { ActionPreview, PendingAction, WriteCapability, WriteHost } from "../write/types";
import {
  answeredSlots,
  carChanged,
  correctedSlot,
  followUpSlot,
  newFrame,
  splitCorrection,
  type Offer,
  type RequestFrame,
  type Slot,
} from "./frame";

// A write request in the conversation (spec 9.3, 9.4, 9.6, 9.9, 11.9 steps 1 to 3): the frame from the capability's
// tool call, one question at a time in the order of spec 9.4, then the dry run and the confirmation. Nothing is sent
// to the host for real before "yes" (D136).

export const CONFIRM_TTL_MS = 60_000;
export const ONE_LINE = "একবারে একটা পার্ট বলুন।";
const NO_ANSWER = "অ্যাপ সাড়া দেয়নি।";
/** A name this close to a customer or supplier is offered as a button when it is not clear enough to take (D148). */
const NEAR_NAME = 0.5;
/** A paikari price change on an app with no paikari price field (D171). */
const NO_PAIKARI = "এই অ্যাপে পাইকারি দাম বদলানো যায় না।";
/** A return's button for a buyer without a name (D169). */
const WALK_IN_LABEL = "নাম ছাড়া কেনা";

const PART_KEYS = [
  "part_type",
  "vehicle",
  "year",
  "engine",
  "position",
  "quality",
  "brand",
  "part_number",
] as const;

export interface WriteTurn {
  capabilities: WriteCapability[];
  host: WriteHost;
  dictionary: Dictionary;
  customers: CatalogCustomer[];
  suppliers: CatalogCustomer[];
  tier: "retail" | "paikari";
  /** Which trade price is the shop's paikari price (D146), for a price change (D171). */
  paikari?: "garage_price" | "wholesale_price" | null;
  /** The remembered customer (spec 9.8): used only where the action needs one and none was named. */
  rememberedCustomer: { hostId: string; name: string } | null;
  now: Date;
  newId: () => string;
  /** The request as first said, for its payment word when the tool call left it out. */
  request: string;
  /** Buttons for a car or part question: the shop's values near what was said, else its common ones (D154). */
  offersFor?: (slot: string) => Offer[];
  find: (query: PartQuery) => Promise<FindPartsResult>;
  /** A return's sale finder over the read path (D169); without it a return cannot find its sale. */
  sales?: (input: { customerId: string | null; partId: string }) => Promise<FoundSales | null>;
  /** The query completed from the request and the memory; `answered` names the slots the user answered (D167). */
  complete: (
    query: PartQuery,
    answered?: ReadonlySet<string>,
  ) => { query: PartQuery; remembered: Set<string> };
  emit: (event: ReplyEvent) => void;
  ask: (frame: RequestFrame, slot: string, text: string, offers: Offer[]) => void;
}

export type WriteStep =
  | { kind: "asked" }
  | { kind: "confirm"; action: PendingAction; text: string }
  | { kind: "answer"; text: string }
  /** The part is not there as asked: the parts answer says what there is. */
  | { kind: "parts"; result: FindPartsResult; query: PartQuery };

/** The part found for the action, with what its confirmation says; kept in the frame, so plain JSON (no bigint). */
interface ChosenPart {
  hostPartId: string;
  name: string;
  nameBn: string | null;
  unit: string | null;
  rack: string | null;
  quality: string | null;
  position: string | null;
  /** The price at the customer's tier (else retail), for the estimate of a host without a dry run. */
  price: number | null;
  /** The part's retail and paikari prices, for a price change's "from" (D171). */
  retail?: number | null;
  paikari?: number | null;
  vehicle: string | null;
  year: number | null;
  partType: string | null;
}

/** A return's sale line as found, with the buyer's due then; kept in the frame, so plain JSON (D169). */
type ChosenSale = SaleLine & { customerDue: number | null };
/** A sale line's button value. */
const saleKey = (line: SaleLine) => `${line.saleId}:${line.lineId ?? ""}`;
/** A return on an app whose sales the read path cannot read. */
const NO_SALES = "এই অ্যাপের আগের বিক্রি পড়তে পারছি না, তাই ফেরতটা অ্যাপেই করুন।";

function chosenOf(
  row: PartRow,
  resolved: { vehicle: string | null; year: number | null; partType: string | null },
  tier: PriceLevel,
): ChosenPart {
  const price = levelPrice(row, tier) ?? row.retailTaka;
  return {
    hostPartId: row.hostPartId,
    name: row.name,
    nameBn: row.nameBn,
    unit: row.unit,
    rack: row.rack,
    quality: row.quality,
    position: row.position,
    price: price === null ? null : Number(price),
    retail: row.retailTaka === null ? null : Number(row.retailTaka),
    paikari: levelPrice(row, "paikari") === null ? null : Number(levelPrice(row, "paikari")),
    vehicle: resolved.vehicle,
    year: resolved.year,
    partType: resolved.partType,
  };
}

const understood = (value: unknown, extra: Partial<Slot> = {}): Slot => ({
  value,
  status: "understood",
  source: "user",
  ...extra,
});
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The frame of a capability's tool call (spec 9.5: frame.fromWriteTool). */
export function writeFrame(
  capability: WriteCapability,
  args: Record<string, unknown>,
  turn: WriteTurn,
): RequestFrame {
  const frame = newFrame(turn.newId(), capability.name, turn.now, turn.request);
  frame.capabilityId = capability.id;
  const put = (name: string, value: unknown) => {
    const text = str(value);
    if (text) frame.slots[name] = understood(text);
  };
  // A number is kept only when the user said it: the model never fills in a quantity, price or amount (D140).
  const said = saidNumbers(turn.request);
  // A unit cost must be said as money, never a quantity the model reads as one (D157).
  const money = saidMoney(turn.request);
  const putSaid = (
    name: string,
    value: unknown,
    read: (text: string) => number | null,
    from: ReadonlySet<number> = said,
  ) => {
    const text = str(value);
    const number = text ? read(text) : null;
    if (text && number !== null && from.has(number)) frame.slots[name] = understood(text);
  };
  const quantityOf = (text: string) => parseQuantity(normalize(text).tokens)?.value ?? null;
  for (const party of ["customer", "supplier"] as const) {
    const name = str(args[party]);
    if (name) frame.slots[party] = { value: name, status: "unclear", source: "user" }; // resolved below
  }
  const items = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
  if (items.length > 1) frame.slots.lines = understood(items.length);
  const item = items[0] ?? {};
  const part = (item.part ?? args.part ?? {}) as Record<string, unknown>;
  for (const key of PART_KEYS) put(key, part[key]);
  putSaid("quantity", item.quantity, quantityOf);
  putSaid("unit_cost", item.unit_cost, parseAmount, money);
  const payment = (args.payment ?? {}) as Record<string, unknown>;
  put("payment", payment.method_word);
  putSaid("paid_amount", payment.amount, parseAmount);
  put("trx_id", payment.trx_id);
  putSaid("amount", args.amount, parseAmount);
  put("note", args.note);
  put("reason", args.reason);
  put("when", args.when);
  // A price change's new price, said as money, of the kind it names (D171).
  const prices = (args.prices ?? {}) as Record<string, unknown>;
  for (const tier of ["paikari", "retail"] as const) {
    if (frame.slots.new_price) break;
    putSaid("new_price", prices[tier], parseAmount, money);
    if (frame.slots.new_price) frame.slots.price_tier = understood(tier);
  }
  // A returned part said to be damaged stays out of stock (D169).
  if (capability.template === "return" && saysDamaged(turn.request)) frame.slots.damaged = understood(true);
  for (const [key, value] of Object.entries(args))
    if (key.startsWith("extra_")) put(`extra.${key.slice(6)}`, value);
  return frame;
}

const slotsOf = writeSlots;

/** A payment word: on credit, a method of the host, or null when it is not one. */
export function paymentOf(
  said: string,
  capability: WriteCapability,
): { credit: true } | { method: string } | null {
  const tokens = normalize(said).tokens;
  const text = ` ${tokens.join(" ")} `;
  if (saysCredit(said)) return { credit: true };
  const param = methodParam(capability);
  if (!param) return null;
  const words = Object.entries(param.spokenMap ?? {})
    .map(([word, value]) => [normalize(word).tokens.join(" "), value] as const)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [word, value] of words) if (word && text.includes(` ${word} `)) return { method: value };
  const direct = param.enumValues?.find((value) => tokens.includes(value.toLowerCase()));
  return direct ? { method: direct } : null;
}

function partQueryOf(frame: RequestFrame): PartQuery {
  const query: PartQuery = {};
  for (const key of PART_KEYS) {
    const value = frame.slots[key]?.value;
    if (typeof value === "string" && value) query[key] = value;
  }
  return query;
}

function partWords(chosen: ChosenPart): string {
  return chosen.partType ? banglaOf("part_type", chosen.partType) : (chosen.nameBn ?? chosen.name);
}

/** The part as a sentence names it: "ফিল্ডারের সামনের ব্রেক প্যাড". */
function partPhrase(chosen: ChosenPart): string {
  return [
    chosen.vehicle ? possessive(banglaOf("vehicle_model", chosen.vehicle)) : null,
    chosen.position ? banglaOf("position", chosen.position) : null,
    partWords(chosen),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * What is already understood, said before the write's first question (spec 9.4): the customer or supplier as said, and
 * the part in the shop's words from what the part search resolved ("রহিম মোটরস, এক্সিওর সামনের ব্রেক প্যাড").
 */
function understoodSoFar(
  frame: RequestFrame,
  resolved?: { vehicle: string | null; position: string | null; partType: string | null },
): string | undefined {
  const partySlot = frame.slots.customer ?? frame.slots.supplier;
  const party = partySlot ? String(partySlot.display ?? partySlot.value) : null;
  const chosen = frame.slots.part?.value as ChosenPart | undefined;
  const vehicle = resolved?.vehicle ?? chosen?.vehicle ?? null;
  const position = resolved?.position ?? chosen?.position ?? null;
  const partType = resolved?.partType ?? chosen?.partType ?? null;
  const part = partType
    ? [
        vehicle ? possessive(banglaOf("vehicle_model", vehicle)) : null,
        position ? banglaOf("position", position) : null,
        banglaOf("part_type", partType),
      ]
        .filter(Boolean)
        .join(" ")
    : null;
  const text = [party, part].filter(Boolean).join(", ");
  return text || undefined;
}

export async function advanceWrite(frame: RequestFrame, turn: WriteTurn): Promise<WriteStep> {
  const capability = turn.capabilities.find((item) => item.id === frame.capabilityId);
  if (!capability) return { kind: "answer", text: resultText("cancelled", "generic") };
  if (Number(frame.slots.lines?.value ?? 1) > 1) return { kind: "answer", text: ONE_LINE };
  turn.host.wake?.(); // a sleeping app wakes while the questions are answered (D168)
  const slots = slotsOf(capability);
  const first = Object.keys(frame.attempts).length === 0;
  const askSlot = (slot: string, text: string, offers: Offer[] = []) => {
    if (offers.length)
      turn.emit({ type: "choices", slot, options: offers.map(({ id, label }) => ({ id, label })) });
    turn.ask(frame, slot, text, offers);
    return { kind: "asked" } as const;
  };
  const ask = (slot: QuestionSlot, extra: Partial<QuestionInput> = {}) =>
    askSlot(slot, question({ slot, ...(first ? { understood: understoodSoFar(frame) } : {}), ...extra }));

  // 1. The part: vehicle, year, engine, position, quality, part type (asked by the part search).
  let chosen = (frame.slots.part?.value as ChosenPart | undefined) ?? null;
  if ((slots.has("items") || slots.has("part")) && !chosen) {
    const query = partQueryOf(frame);
    if (!query.part_type && !query.part_number) return ask("part_type");
    const answered = answeredSlots(frame);
    const full = turn.complete(query, answered);
    for (const [key, value] of Object.entries(full.query)) {
      if (!frame.slots[key])
        frame.slots[key] = {
          value,
          status: "understood",
          source: full.remembered.has(key) ? "context" : "user",
        };
    }
    const result = await turn.find(full.query);
    if (result.kind === "ask") {
      const listed: Offer[] = result.options.map((option, index) => ({
        id: `opt-${index + 1}`,
        label: result.slot === "year" ? option.replace("-", "–") : option,
        // A year button is its car rows' years, so it picks exactly them (D167).
        value: option,
      }));
      const offers = listed.length ? listed : (turn.offersFor?.(result.slot) ?? []);
      if (result.slot === "part_number")
        return askSlot(
          "part_number",
          offers.length
            ? `${offers.map((offer) => offer.label).join(" বা ")}, কোনটা?`
            : "এই পার্ট নম্বর পাইনি, আবার বলবেন?",
          offers,
        );
      return askSlot(
        result.slot,
        question({
          slot: result.slot,
          ...(first ? { understood: understoodSoFar(frame, result.resolved) } : {}),
          ...(result.resolved.vehicle ? { vehicle: result.resolved.vehicle } : {}),
        }),
        offers,
      );
    }
    if (result.kind === "none" || result.unmet) return { kind: "parts", result, query: full.query };
    let rows = result.rows;
    const picked = str(frame.slots.part_pick?.value);
    if (picked) rows = rows.filter((row) => row.hostPartId === picked);
    if (rows.length > 1) {
      const separated = separatingSlot(rows, turn.tier, answered);
      if (separated) {
        const chips = slotChips(separated.slot, separated.options);
        const offers = chips.map((chip, index) => ({
          id: chip.id,
          label: chip.label,
          value: separated.options[index]!.value,
        }));
        turn.emit({ type: "choices", slot: separated.slot, options: chips });
        turn.ask(
          frame,
          separated.slot,
          question({
            slot: separated.slot as QuestionSlot,
            ...(first ? { understood: understoodSoFar(frame, result.resolved) } : {}),
            ...(result.resolved.vehicle ? { vehicle: result.resolved.vehicle } : {}),
          }),
          offers,
        );
        return { kind: "asked" };
      }
      const listed = rows.slice(0, 6);
      const named = (row: PartRow) => [row.nameBn ?? row.name, row.brand].filter(Boolean).join(", ");
      // Two parts that read the same (one per generation, after a year that two cars share) say their car's years.
      const label = (row: PartRow) => {
        const twin = listed.some((other) => other !== row && named(other) === named(row));
        const car = row.vehicle && row.vehicle.yearFrom > 0 ? row.vehicle : null;
        return twin && car
          ? `${named(row)} (${yearText(car.yearFrom)}–${car.yearTo ? yearText(car.yearTo) : ""})`
          : named(row);
      };
      const offers = listed.map((row, index) => ({
        id: `opt-${index + 1}`,
        label: label(row),
        value: row.hostPartId,
      }));
      return askSlot("part_pick", `${offers.map((offer) => offer.label).join(" না ")}?`, offers);
    }
    if (!rows.length) return { kind: "parts", result, query: full.query };
    chosen = chosenOf(rows[0]!, result.resolved, turn.tier);
    frame.slots.part = understood(chosen, { display: partWords(chosen), hostId: chosen.hostPartId });
  }

  // 2. The customer or supplier: named ones are resolved; one the action needs is asked (or remembered). A return
  // finds its sale by who bought it, so it asks for its buyer, with a button for a walk-in (D169).
  const returning = slots.has("sale_ref");
  if (returning && frame.slots.customer?.value === WALK_IN) {
    frame.slots.walk_in = understood(true, { display: WALK_IN_LABEL });
    delete frame.slots.customer;
  }
  const walkIn: Offer = { id: "opt-walk-in", label: WALK_IN_LABEL, value: WALK_IN };
  for (const party of ["customer", "supplier"] as const) {
    const forReturn = party === "customer" && returning;
    if ((!slots.has(party) && !forReturn) || (forReturn && frame.slots.walk_in)) continue;
    const list = party === "customer" ? turn.customers : turn.suppliers;
    const slot = frame.slots[party];
    const required =
      forReturn || capability.params.some((param) => param.semanticSlot === party && param.required);
    const askParty = (offers: Offer[]) =>
      askSlot(
        party,
        question({
          slot: party,
          ...(forReturn ? { returning: true } : {}),
          ...(first ? { understood: understoodSoFar(frame) } : {}),
        }),
        forReturn ? [...offers, walkIn] : offers,
      );
    // A name picked from the chips carries its host ID as the slot's value.
    const picked = slot && !slot.hostId ? list.find((person) => person.hostId === slot.value) : undefined;
    if (picked) {
      frame.slots[party] = understood(picked.name, { display: picked.name, hostId: picked.hostId });
    } else if (slot && !slot.hostId) {
      const match = resolveCustomer(String(slot.value), [], list, turn.dictionary);
      const [best, second] = match.candidates;
      if (best && (match.decision === "understood" || match.decision === "understood_bold")) {
        // A name the LLM chose among near names keeps its lower confidence, so it is bold (D153).
        frame.slots[party] = understood(best.customer.name, {
          display: best.customer.name,
          hostId: best.customer.hostId,
          confidence: Math.min(best.score, slot.confidence ?? 1),
        });
      } else if (match.decision === "ambiguous" && best && second) {
        const offers = [best, second].map((candidate, index) => ({
          id: `opt-${index + 1}`,
          label: candidate.customer.name,
          value: candidate.customer.hostId,
        }));
        delete frame.slots[party];
        return askSlot(party, question({ slot: party, names: offers.map((offer) => offer.label) }), offers);
      } else {
        // Not clear enough to take: the closest names as buttons, so a misheard name is one tap away (D148). The name
        // as heard is kept, so the answer can teach how speech-to-text writes it (D155).
        frame.slots[`said_${party}`] = { value: String(slot.value), status: "unclear", source: "user" };
        delete frame.slots[party];
        const near = match.candidates.filter((candidate) => candidate.score >= NEAR_NAME).slice(0, 3);
        if (!near.length && !forReturn) return ask(party);
        return askParty(
          near.map((candidate, index) => ({
            id: `opt-${index + 1}`,
            label: candidate.customer.name,
            value: candidate.customer.hostId,
          })),
        );
      }
    } else if (!slot && required) {
      if (party === "customer" && turn.rememberedCustomer) {
        frame.slots.customer = {
          value: turn.rememberedCustomer.name,
          display: turn.rememberedCustomer.name,
          hostId: turn.rememberedCustomer.hostId,
          status: "understood",
          source: "context",
        };
      } else return forReturn ? askParty([]) : ask(party);
    }
  }

  // 2b. A return's sale (D169): the buyer's sales of the part in the last 30 days, through the read path.
  let sale = (frame.slots.sale?.value as ChosenSale | undefined) ?? null;
  if (returning && chosen && !sale) {
    const walkedIn = Boolean(frame.slots.walk_in);
    const found = turn.sales
      ? await turn.sales({
          customerId: walkedIn ? null : (frame.slots.customer?.hostId ?? null),
          partId: chosen.hostPartId,
        })
      : null;
    if (!found) return { kind: "answer", text: NO_SALES };
    let lines = found.lines;
    const answer = frame.slots.sale_ref?.value;
    const tapped = lines.find((line) => saleKey(line) === answer);
    if (tapped) lines = [tapped];
    else {
      // A day said with the request or as the answer ("গতকাল", "৩ দিন আগে") picks among the sales; the confirmation
      // says the day, so a wrong pick is one "না" away.
      const said = str(answer) ?? str(frame.slots.when?.value) ?? frame.request ?? null;
      const days = said ? daysAgoSaid(said) : null;
      const that = lines.filter((line) => daysBefore(new Date(line.time), turn.now) === days);
      if (that.length) lines = that;
    }
    if (!lines.length) {
      const party = walkedIn
        ? null
        : String(frame.slots.customer?.display ?? frame.slots.customer?.value ?? "");
      return {
        kind: "answer",
        text: party
          ? `${possessive(party)} কাছে গত ৩০ দিনে ${partPhrase(chosen)} বিক্রি পাইনি।`
          : `গত ৩০ দিনে নাম ছাড়া ${partPhrase(chosen)} বিক্রি পাইনি।`,
      };
    }
    if (lines.length > 1) {
      delete frame.slots.sale_ref;
      const unit = chosen.unit ?? "piece";
      return askSlot(
        "sale_ref",
        question({ slot: "sale_ref" }),
        lines.slice(0, 5).map((line, index) => ({
          id: `opt-${index + 1}`,
          label: `${dayText(new Date(line.time), turn.now)}, ${quantityText(line.left, unit)}`,
          value: saleKey(line),
        })),
      );
    }
    sale = { ...lines[0]!, customerDue: found.customerDue };
    frame.slots.sale = understood(sale, { display: dayText(new Date(sale.time), turn.now) });
  }

  // 3. The quantity, in the part's own unit (spec 10.6: a unit that differs is asked, never converted); a return's
  // never more than its sale's line has left, and a line of one is one (D169).
  if (slots.has("items") && chosen) {
    const unit = chosen.unit ?? "piece";
    const slot = frame.slots.quantity;
    const forReturn = sale ? { returning: true } : {};
    if (!slot && sale?.left === 1) frame.slots.quantity = understood(1, { display: quantityText(1, unit) });
    else if (!slot) return ask("quantity", { unit, ...forReturn });
    else if (typeof slot.value !== "number") {
      const said =
        typeof slot.value === "string"
          ? parseQuantity(normalize(slot.value).tokens)
          : (slot.value as SaidQuantity | null);
      const check = said ? checkQuantity(said, { unit }) : null;
      if (!check?.ok) {
        delete frame.slots.quantity;
        return ask("quantity", { unit, ...forReturn });
      }
      if (sale && check.quantity > sale.left) {
        delete frame.slots.quantity;
        return ask("quantity", { unit, returning: true, sold: quantityText(sale.left, unit) });
      }
      frame.slots.quantity = understood(check.quantity, { display: quantityText(check.quantity, unit) });
    }
  }

  // 4. The unit cost of a purchase.
  const costParam = capability.params.find(
    (param) => param.semanticSlot === "items" && /cost/.test(leafOf(param.path)),
  );
  if (costParam?.required && chosen) {
    const slot = frame.slots.unit_cost;
    const cost = slot
      ? typeof slot.value === "number"
        ? slot.value
        : parseAmount(String(slot.value))
      : null;
    if (cost === null) {
      delete frame.slots.unit_cost;
      return ask("unit_cost", { unit: chosen.unit ?? "piece" });
    }
    frame.slots.unit_cost = understood(cost, { display: money(BigInt(cost)) });
  }

  // 4b. A price change (D171): which price, by the request's words, and the new one, said as money.
  if (slots.has("prices") && chosen) {
    const tier =
      priceLevelIn(turn.request) ??
      (frame.slots.price_tier?.value as "retail" | "paikari" | undefined) ??
      "retail";
    if (tier === "paikari" && !takesPaikari(capability)) return { kind: "answer", text: NO_PAIKARI };
    frame.slots.price_tier = understood(tier);
    const slot = frame.slots.new_price;
    const price = slot
      ? typeof slot.value === "number"
        ? slot.value
        : parseAmount(String(slot.value))
      : null;
    if (price === null) {
      delete frame.slots.new_price;
      return ask("new_price", { tier });
    }
    frame.slots.new_price = understood(price, { display: money(BigInt(price)) });
  }

  // 5. How it is paid: বাকিতে, নগদে or a method (a received payment with no word is cash, spec 9.6).
  if (slots.has("payment")) {
    const slot = frame.slots.payment;
    let value = slot?.value as { credit?: true; method?: string } | string | undefined;
    if (value === undefined) {
      const heard = paymentOf(turn.request, capability);
      const party = frame.slots.customer?.hostId ?? frame.slots.supplier?.hostId;
      if (heard) value = heard;
      else if (capability.template === "payment" || !party) {
        const cash = cashMethod(capability);
        if (!cash) return ask("payment");
        value = { method: cash };
      } else {
        const cash = cashMethod(capability);
        return askSlot("payment", question({ slot: "payment" }), [
          { id: "opt-1", label: "বাকিতে", value: "বাকিতে" },
          ...(cash ? [{ id: "opt-2", label: "নগদে", value: "নগদে" }] : []),
        ]);
      }
    } else if (typeof value === "string") {
      const heard = paymentOf(value, capability);
      if (!heard || ("credit" in heard && capability.template === "payment")) {
        delete frame.slots.payment;
        return ask("payment");
      }
      value = heard;
    }
    frame.slots.payment = understood(value, {
      display: "credit" in value ? "বাকিতে" : methodText(value.method ?? ""),
    });
  }

  // 6. An amount of money.
  if (slots.has("amount")) {
    const slot = frame.slots.amount;
    const amount = slot
      ? typeof slot.value === "number"
        ? slot.value
        : parseAmount(String(slot.value))
      : null;
    if (amount === null) {
      delete frame.slots.amount;
      return ask("amount");
    }
    frame.slots.amount = understood(amount, { display: money(BigInt(amount)) });
  }

  // 7. Anything else the host requires (spec 9.6 extra.<name>).
  for (const param of capability.params) {
    if (!param.required || param.semanticSlot || param.location !== "body") continue;
    const key = `extra.${leafOf(param.path)}`;
    if (!str(frame.slots[key]?.value))
      return askSlot(key, question({ slot: "other", label: leafOf(param.path).replaceAll("_", " ") }));
  }

  return prepareWrite(frame, capability, chosen, turn);
}

/** The values understood, in the host's terms. */
function resolvedOf(frame: RequestFrame, chosen: ChosenPart | null): ResolvedWrite {
  const party = (name: "customer" | "supplier") =>
    frame.slots[name]?.hostId
      ? {
          hostId: frame.slots[name]!.hostId!,
          name: String(frame.slots[name]!.display ?? frame.slots[name]!.value),
        }
      : null;
  const payment = frame.slots.payment?.value as { credit?: true; method?: string } | undefined;
  const sale = frame.slots.sale?.value as ChosenSale | undefined;
  const paid = str(frame.slots.paid_amount?.value)
    ? parseAmount(String(frame.slots.paid_amount!.value))
    : null;
  return {
    customer: party("customer"),
    supplier: party("supplier"),
    line: chosen
      ? {
          hostPartId: chosen.hostPartId,
          quantity: Number(frame.slots.quantity?.value ?? 0),
          unitCost: typeof frame.slots.unit_cost?.value === "number" ? frame.slots.unit_cost.value : null,
        }
      : null,
    payments:
      payment?.method !== undefined
        ? [{ method: payment.method, amount: paid, trxId: str(frame.slots.trx_id?.value) }]
        : [],
    amount: typeof frame.slots.amount?.value === "number" ? frame.slots.amount.value : null,
    note: str(frame.slots.note?.value),
    reason: str(frame.slots.reason?.value),
    saleRef: sale ? { saleId: sale.saleId, lineId: sale.lineId } : null,
    refund: null,
    damaged: Boolean(frame.slots.damaged),
    part: chosen ? { hostId: chosen.hostPartId } : null,
    prices:
      typeof frame.slots.new_price?.value === "number"
        ? {
            [frame.slots.price_tier?.value === "paikari" ? "paikari" : "retail"]: frame.slots.new_price.value,
          }
        : null,
    extras: Object.fromEntries(
      Object.entries(frame.slots)
        .filter(([key]) => key.startsWith("extra."))
        .map(([key, slot]) => [key.slice(6), String(slot.value)]),
    ),
  };
}

/** Steps 2 and 3 of spec 11.9: the dry run (or an estimate from mapped prices), then the confirmation. */
async function prepareWrite(
  frame: RequestFrame,
  capability: WriteCapability,
  chosen: ChosenPart | null,
  turn: WriteTurn,
): Promise<WriteStep> {
  const resolved = resolvedOf(frame, chosen);
  const template = capability.template;
  const dry = capability.dryRun ? dryRunQuery(turn.host.features) : null;
  const sale = template === "return" ? ((frame.slots.sale?.value as ChosenSale | undefined) ?? null) : null;
  const walkedIn = Boolean(frame.slots.walk_in);
  const slots = slotsOf(capability);
  resolved.paikariField = turn.paikari ?? null;
  // An action that names its part in the path gets the part's ID there (D171).
  const path = requestPath(capability, resolved);
  const send = async (body: Record<string, unknown>, query: Record<string, string>) => {
    const request = { method: capability.httpMethod, path, query, body };
    try {
      return await turn.host.call(request);
    } catch (error) {
      if (!(error instanceof HostCallFailed) || error.reason !== "timeout") throw error;
      // An app asleep, as a free host is after quiet minutes: a dry run saves nothing, so it is sent once more and
      // waited for longer, while the screen says "চালু হচ্ছে…" (D168).
      turn.emit({ type: "status", state: "UNDERSTANDING", label_key: "status.starting" });
      return turn.host.call(request, { timeoutMs: WAKE_WAIT_MS });
    }
  };
  let total: number | null = null;
  let warnings: string[] = [];
  try {
    if (dry) {
      if (sale) {
        // A return's refund needs its total and the buyer's due: a first dry run without the refund reads them
        // (spec 11.9 step 1).
        const response = await send(buildBody(capability, { ...resolved, refund: null }).body, dry);
        if (response.status >= 300)
          return {
            kind: "answer",
            text: resultText("failed", template, { reason: refusalOf(response, turn.host.features) }),
          };
        const facts = answerFacts(response.body);
        total = facts.total;
        resolved.refund = refundOf(capability, {
          total: total ?? 0,
          customerDue: facts.customerDue ?? sale.customerDue,
          saleDue: sale.saleDue,
          walkIn: walkedIn,
        });
      }
      if (open(resolved) && template !== "payment") {
        // The amount of a "নগদে" payment is the total: a first dry run without payments reads it.
        const response = await send(buildBody(capability, { ...resolved, payments: [] }).body, dry);
        if (response.status >= 300)
          return {
            kind: "answer",
            text: resultText("failed", template, { reason: refusalOf(response, turn.host.features) }),
          };
        total = answerFacts(response.body).total;
        resolved.payments = resolved.payments!.map((payment) => ({
          ...payment,
          amount: payment.amount ?? total,
        }));
      }
      const response = await send(buildBody(capability, resolved).body, dry);
      if (response.status >= 300)
        return {
          kind: "answer",
          text: resultText("failed", template, { reason: refusalOf(response, turn.host.features) }),
        };
      const facts = answerFacts(response.body);
      total = facts.total ?? total;
      warnings = facts.warnings;
    }
  } catch (error) {
    if (error instanceof HostCallFailed)
      return { kind: "answer", text: resultText("failed", template, { reason: NO_ANSWER }) };
    throw error;
  }
  if (!dry) {
    // No dry run: the total from mapped prices, read back as an estimate (architecture, host features).
    const line = resolved.line;
    if (template === "payment") total = resolved.amount ?? null;
    else if (sale && line) {
      // A return without a dry run: the line's sold price, and the buyer's due from the read path (D169).
      const each = sale.unitPrice ?? chosen?.price ?? null;
      total = each !== null ? each * line.quantity : null;
      resolved.refund = refundOf(capability, {
        total: total ?? 0,
        customerDue: sale.customerDue,
        saleDue: sale.saleDue,
        walkIn: walkedIn,
      });
    } else if (line && line.unitCost != null) total = line.unitCost * line.quantity;
    else if (line && chosen) total = chosen.price !== null ? chosen.price * line.quantity : null;
    if (open(resolved) && total !== null)
      resolved.payments = resolved.payments!.map((payment) => ({
        ...payment,
        amount: payment.amount ?? total,
      }));
  }

  const { body } = buildBody(capability, resolved);
  const paid =
    template === "payment"
      ? (resolved.amount ?? 0)
      : (resolved.payments ?? []).reduce((sum, payment) => sum + (payment.amount ?? 0), 0);
  const unit = chosen?.unit ?? "piece";
  const quantity = resolved.line?.quantity ?? 0;
  // A price change (D171): which price, from what, to what; its sentence names the part as the owner did.
  const change =
    slots.has("prices") && resolved.prices
      ? {
          tier: (resolved.prices.paikari != null ? "paikari" : "retail") as "retail" | "paikari",
          price: resolved.prices.paikari ?? resolved.prices.retail ?? 0,
        }
      : null;
  const before = change && chosen ? (change.tier === "paikari" ? chosen.paikari : chosen.retail) : null;
  const lines: ActionLine[] =
    change && chosen
      ? [{ part: partPhrase(chosen) }]
      : chosen
        ? [
            {
              vehicle: chosen.vehicle ?? undefined,
              year: chosen.year,
              position: chosen.position,
              part: partWords(chosen),
              quality: chosen.quality,
              quantity: quantityText(quantity, unit),
              unit: unitWord(unit),
              unitCost: resolved.line?.unitCost != null ? BigInt(resolved.line.unitCost) : null,
            },
          ]
        : [];
  const payments = (resolved.payments ?? []).map((payment) => ({
    method: payment.method,
    amount: BigInt(payment.amount ?? 0),
  }));
  const fields: ActionFields = {
    customer: resolved.customer?.name ?? null,
    supplier: resolved.supplier?.name ?? null,
    lines,
    total: total !== null ? BigInt(total) : null,
    amount: resolved.amount != null ? BigInt(resolved.amount) : null,
    payment:
      template === "payment"
        ? methodText(resolved.payments?.[0]?.method ?? "cash")
        : sale || !slots.has("payment")
          ? null
          : paymentText(payments, total !== null ? BigInt(total) : null),
    ...(change
      ? {
          tier: change.tier,
          oldPrice: before !== null && before !== undefined ? BigInt(before) : null,
          newPrice: BigInt(change.price),
        }
      : {}),
    // A return says its sale's day and how the money goes back (spec 11.10; D169).
    ...(sale
      ? {
          date: dayText(new Date(sale.time), turn.now, { of: true }),
          refund: resolved.refund
            ? refundText(BigInt(resolved.refund.due), BigInt(resolved.refund.cash))
            : null,
        }
      : {}),
  };
  const text = confirmationText(template, fields);
  const highlight = (name: string) => (frame.slots[name]?.confidence ?? 1) < 0.85;
  /** The part is bold when its car or part type was a near word the LLM chose (D153). */
  const partGuessed = highlight("vehicle") || highlight("part_type");
  const sheet: ActionPreview["fields"] = [
    ...(fields.customer
      ? [{ label: "কাস্টমার", value: fields.customer, highlight: highlight("customer") }]
      : sale && walkedIn
        ? [{ label: "কাস্টমার", value: WALK_IN_LABEL, highlight: false }]
        : []),
    ...(sale
      ? [{ label: "বিক্রির দিন", value: dayText(new Date(sale.time), turn.now), highlight: false }]
      : []),
    ...(fields.supplier
      ? [{ label: "সাপ্লায়ার", value: fields.supplier, highlight: highlight("supplier") }]
      : []),
    ...(chosen
      ? [
          {
            label: "পার্ট",
            value: [
              chosen.vehicle ? banglaOf("vehicle_model", chosen.vehicle) : null,
              lines[0]!.part,
              chosen.quality ? banglaOf("quality", chosen.quality) : null,
            ]
              .filter(Boolean)
              .join(", "),
            highlight: partGuessed,
          },
          ...(slots.has("items")
            ? [{ label: "পরিমাণ", value: quantityText(quantity, unit), highlight: false }]
            : []),
        ]
      : []),
    ...(change
      ? [
          { label: "দাম", value: change.tier === "paikari" ? "পাইকারি" : "খুচরা", highlight: false },
          ...(before !== null && before !== undefined
            ? [{ label: "আগে", value: money(BigInt(before)), highlight: false }]
            : []),
          { label: "নতুন", value: money(BigInt(change.price)), highlight: false },
        ]
      : []),
    ...(fields.amount != null ? [{ label: "টাকা", value: money(fields.amount), highlight: false }] : []),
    ...(fields.total != null && template !== "payment"
      ? [{ label: sale ? "ফেরত" : "মোট", value: money(fields.total), highlight: false }]
      : []),
    ...(fields.payment ? [{ label: "পেমেন্ট", value: fields.payment, highlight: false }] : []),
    ...(fields.refund ? [{ label: "কীভাবে", value: fields.refund, highlight: false }] : []),
  ];
  const balanceChange =
    template === "payment"
      ? -paid
      : sale
        ? resolved.customer && resolved.refund
          ? -resolved.refund.due
          : null
        : total !== null && (resolved.customer || resolved.supplier)
          ? total - paid
          : null;
  /** A returned part goes back to stock, unless it is said damaged to a host that keeps it out (D169). */
  const backToStock = resolved.damaged && takesDamaged(capability) ? 0 : quantity;
  const preview: ActionPreview = {
    template,
    text,
    fields: sheet,
    warnings,
    total,
    paid,
    lines: chosen
      ? [
          {
            hostPartId: chosen.hostPartId,
            name: partWords(chosen),
            quantity,
            unit: chosen.unit,
            rack: chosen.rack,
          },
        ]
      : [],
    customer: resolved.customer ?? null,
    supplier: resolved.supplier ?? null,
    expect: {
      stock: chosen
        ? {
            [chosen.hostPartId]:
              template === "stock_in" ? quantity : template === "sale" ? -quantity : sale ? backToStock : 0,
          }
        : {},
      balance: balanceChange,
    },
  };
  const action: PendingAction = {
    id: turn.newId(),
    capabilityId: capability.id,
    request: { method: capability.httpMethod, path, query: {}, body },
    preview,
    idempotencyKey: turn.newId(),
    expiresAt: new Date(turn.now.getTime() + CONFIRM_TTL_MS).toISOString(),
  };
  turn.emit({
    type: "confirm",
    action_id: action.id,
    text,
    fields: sheet,
    warnings,
    expires_at: action.expiresAt,
  });
  // The host's warnings are said before the question, so the question is the last thing heard.
  return { kind: "confirm", action, text: [...warnings, text].join(" ") };
}

const open = (resolved: ResolvedWrite) =>
  resolved.payments?.some((payment) => payment.amount === null) ?? false;

/**
 * A correction while the confirmation waits (spec 9.9): "না, X" or a value alone changes the slot it belongs to (a
 * quantity with its unit, a part detail, how it is paid, an amount, a name). Returns the slot, or null when the input
 * changes nothing.
 */
export function correctWrite(
  frame: RequestFrame,
  text: string,
  capability: WriteCapability,
  turn: Pick<WriteTurn, "dictionary" | "customers" | "suppliers" | "now">,
): string | null {
  const { rest } = splitCorrection(text);
  const tokens = normalize(rest).tokens;
  if (!tokens.length) return null;
  const slots = slotsOf(capability);
  const forPart = slots.has("items") || slots.has("part");
  const said = parseQuantity(tokens);
  if (slots.has("items") && said?.unit) {
    frame.slots.quantity = understood(rest);
    return "quantity";
  }
  const detail =
    correctedSlot(text, turn.dictionary, turn.now) ?? followUpSlot(rest, turn.dictionary, turn.now);
  if (detail && forPart) {
    frame.slots[detail.slot] = understood(detail.value);
    carChanged(frame, detail.slot);
    delete frame.slots.part;
    delete frame.slots.part_pick;
    return detail.slot;
  }
  if (slots.has("payment") && paymentOf(rest, capability)) {
    frame.slots.payment = understood(rest);
    return "payment";
  }
  if (slots.has("amount")) {
    const amount = parseAmount(rest);
    if (amount !== null) {
      frame.slots.amount = understood(amount);
      return "amount";
    }
  }
  if (slots.has("items") && said) {
    frame.slots.quantity = understood(rest);
    return "quantity";
  }
  for (const party of ["customer", "supplier"] as const) {
    if (!slots.has(party)) continue;
    const match = resolveCustomer(
      rest,
      [],
      party === "customer" ? turn.customers : turn.suppliers,
      turn.dictionary,
    );
    if (match.decision === "understood" || match.decision === "understood_bold") {
      frame.slots[party] = { value: rest, status: "unclear", source: "user" };
      return party;
    }
  }
  return null;
}
