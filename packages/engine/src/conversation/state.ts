// The conversation's state machine (spec 9.2): kept in memory and in conversations.state; a transition that is not
// in this table is refused.

export const STATES = [
  "IDLE",
  "LISTENING",
  "UNDERSTANDING",
  "CLARIFYING",
  "CONFIRMING",
  "EXECUTING",
  "RESPONDING",
] as const;
export type ConversationState = (typeof STATES)[number];

const TRANSITIONS: Record<ConversationState, readonly ConversationState[]> = {
  IDLE: ["LISTENING", "UNDERSTANDING"],
  LISTENING: ["UNDERSTANDING", "IDLE"],
  UNDERSTANDING: ["CLARIFYING", "CONFIRMING", "EXECUTING", "RESPONDING"],
  CLARIFYING: ["LISTENING", "UNDERSTANDING", "IDLE"],
  CONFIRMING: ["EXECUTING", "UNDERSTANDING", "IDLE"],
  EXECUTING: ["RESPONDING"],
  RESPONDING: ["IDLE", "CLARIFYING", "CONFIRMING"],
};

export class TransitionRefused extends Error {}

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(from: ConversationState, to: ConversationState): ConversationState {
  if (!canTransition(from, to)) throw new TransitionRefused(`${from} -> ${to}`);
  return to;
}
