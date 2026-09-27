import {
  matchConcept,
  normalize,
  parseQuantity,
  parseYear,
  resolveCustomer,
  type AliasConcept,
  type CatalogCustomer,
  type Dictionary,
} from "@dokaanbondhu/core";

// The request frame (spec 9.3): what one request has understood so far, and the one question it is waiting for.
// When a frame is asking, the next input is first parsed as a value of that slot with the deterministic parser for
// its type; success fills only that slot. "No, X" changes the slot the value belongs to.

export type SlotStatus = "understood" | "missing" | "unclear";

export interface Slot {
  value: unknown;
  display?: string;
  hostId?: string;
  status: SlotStatus;
  confidence?: number;
  source: "user" | "context" | "default" | "resolver";
}

export interface Offer {
  id: string;
  label: string;
  value: string;
}

export interface RequestFrame {
  id: string;
  intent: string; // "find_parts", "read_query", "resolve_customer", or a capability name
  capabilityId?: string;
  slots: Record<string, Slot>;
  asking?: string;
  /** The options offered with the last question (chips), for a tap or a spoken choice. */
  offers?: Offer[];
  /** The request as first said, so a question's answer can finish it. */
  request?: string;
  attempts: Record<string, number>;
  status: "active" | "set_aside" | "confirming" | "done" | "cancelled" | "expired";
  expiresAt: string;
}

export const FRAME_TTL_MS = 120_000;

/** Required slots of the reads (spec 9.3 rule 1): find_parts needs a part type and a vehicle. */
export const READ_REQUIRED: Record<string, string[]> = { find_parts: ["part_type", "vehicle"] };

export function newFrame(id: string, intent: string, now: Date, request?: string): RequestFrame {
  return {
    id,
    intent,
    slots: {},
    attempts: {},
    status: "active",
    expiresAt: new Date(now.getTime() + FRAME_TTL_MS).toISOString(),
    ...(request ? { request } : {}),
  };
}

export function isOpen(frame: RequestFrame | null, now: Date): frame is RequestFrame {
  return Boolean(
    frame &&
    (frame.status === "active" || frame.status === "confirming") &&
    Date.parse(frame.expiresAt) > now.getTime(),
  );
}

/** Renews the 120 s window (every answer renews it). */
export function renew(frame: RequestFrame, now: Date): void {
  frame.expiresAt = new Date(now.getTime() + FRAME_TTL_MS).toISOString();
}

export function setSlot(frame: RequestFrame, name: string, slot: Slot): void {
  frame.slots[name] = slot;
  if (frame.asking === name) {
    delete frame.asking;
    delete frame.offers;
  }
}

/** Marks a question asked; after two failed attempts at one slot, the question comes with chips (rule 5). */
export function asking(
  frame: RequestFrame,
  slot: string,
  offers: Offer[] = [],
): { attempt: number; withChips: boolean } {
  const attempt = (frame.attempts[slot] ?? 0) + 1;
  frame.attempts[slot] = attempt;
  frame.asking = slot;
  frame.offers = offers;
  return { attempt, withChips: offers.length > 0 || attempt > 2 };
}

const NO_WORDS = new Set(["না", "না না", "na", "naa", "no"]);

/** "না, ২০১২": a correction, and the value after the no. */
export function splitCorrection(text: string): { correction: boolean; rest: string } {
  const tokens = normalize(text).tokens;
  const first = tokens[0] ?? "";
  if (NO_WORDS.has(first) && tokens.length > 1) return { correction: true, rest: tokens.slice(1).join(" ") };
  return { correction: false, rest: text };
}

const CONCEPT_OF: Record<string, AliasConcept> = {
  part_type: "part_type",
  vehicle: "vehicle_model",
  quality: "quality",
  position: "position",
  brand: "brand",
};

export interface FrameAnswerInput {
  text?: string;
  choice?: { slot: string; optionId: string };
  dictionary: Dictionary;
  customers: CatalogCustomer[];
  now: Date;
}

/**
 * Tries the input as a value of the slot the frame is asking about (rule 3). A tap on a chip, or a spoken option,
 * fills it; otherwise the deterministic parser of the slot's type. Returns the filled slot's name, or null when the
 * input is something else (a correction of another slot or a new request goes on to the LLM).
 */
export function answerFrame(frame: RequestFrame, input: FrameAnswerInput): string | null {
  const slot = frame.asking;
  if (!slot) return null;
  if (input.choice) {
    const offer = frame.offers?.find((candidate) => candidate.id === input.choice?.optionId);
    if (!offer || input.choice.slot !== slot) return null;
    setSlot(frame, slot, { value: offer.value, display: offer.label, status: "understood", source: "user" });
    return slot;
  }
  const { rest } = splitCorrection(input.text ?? "");
  const text = rest.trim();
  if (!text) return null;
  const offered = frame.offers?.find(
    (offer) => normalize(offer.label).tokens.join(" ") === normalize(text).tokens.join(" "),
  );
  if (offered) {
    setSlot(frame, slot, {
      value: offered.value,
      display: offered.label,
      status: "understood",
      source: "user",
    });
    return slot;
  }
  const tokens = normalize(text).tokens;
  let value: unknown = null;
  let display: string | undefined;
  let confidence: number | undefined;
  if (slot === "year") {
    const year = parseYear(tokens, { now: input.now, bare: tokens.length <= 3 });
    if (year !== null) value = String(year);
  } else if (slot === "quantity") {
    const quantity = parseQuantity(tokens);
    if (quantity) value = quantity;
  } else if (slot === "customer" || slot === "supplier") {
    const allowed = frame.offers?.length
      ? input.customers.filter((customer) => frame.offers!.some((offer) => offer.value === customer.hostId))
      : input.customers;
    const match = resolveCustomer(text, [], allowed, input.dictionary);
    const best = match.candidates[0];
    if (best && (match.decision === "understood" || match.decision === "understood_bold")) {
      value = best.customer.name;
      display = best.customer.name;
      frame.slots[slot] = {
        value,
        display,
        hostId: best.customer.hostId,
        status: "understood",
        source: "user",
        confidence: best.score,
      };
      delete frame.asking;
      delete frame.offers;
      return slot;
    }
  } else if (CONCEPT_OF[slot]) {
    const match = matchConcept(CONCEPT_OF[slot]!, text, [], input.dictionary);
    const best = match.candidates[0];
    if (best && match.decision !== "unclear") {
      value = text;
      confidence = best.score;
    }
  }
  if (value === null) return null;
  setSlot(frame, slot, {
    value,
    ...(display ? { display } : {}),
    status: "understood",
    source: "user",
    ...(confidence ? { confidence } : {}),
  });
  return slot;
}

/** The slot a corrected value belongs to (rule 3: "No, X" changes that slot). */
export function correctedSlot(
  text: string,
  dictionary: Dictionary,
  now: Date,
): { slot: string; value: string } | null {
  const { correction, rest } = splitCorrection(text);
  if (!correction) return null;
  const tokens = normalize(rest).tokens;
  const year = parseYear(tokens, { now, bare: tokens.length <= 2 });
  if (year !== null) return { slot: "year", value: String(year) };
  for (const [slot, concept] of Object.entries(CONCEPT_OF)) {
    const match = matchConcept(concept, rest, [], dictionary);
    if (match.candidates[0] && match.decision !== "unclear") return { slot, value: rest };
  }
  return null;
}
