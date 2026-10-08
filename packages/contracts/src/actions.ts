import { z } from "zod";

// Actions (spec 8.3, 9.9): the decision from the confirmation sheet's buttons. The reply is the NDJSON stream of a
// turn, as if the user had said yes or no.

export const actionDecisionSchema = z
  .object({
    decision: z.enum(["yes", "no"]),
    /** As on the chat page: the reply is also spoken (D88). */
    speak: z.boolean().optional(),
  })
  .strict();
export type ActionDecision = z.infer<typeof actionDecisionSchema>;
