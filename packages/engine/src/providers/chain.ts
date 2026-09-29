import { decryptSecret } from "../crypto";
import { openAiCompatibleProvider, type LlmProvider } from "./llm";
import { selectProviders, type ProviderRow, type Sides } from "./select";

// Builds the LLM chain of a shop from its ai_providers rows (spec 13.2, 13.3): the side the developer chose first, the
// other side as the backup (D98). Secrets are decrypted only here, inside the adapters, and never logged (spec 13.5).

export interface StoredProviderRow extends ProviderRow {
  baseUrl: string | null;
  secretEncrypted: string | null;
  options: unknown;
}

interface ProviderOptions {
  extra_body?: Record<string, unknown>;
}

export function llmChain(
  rows: StoredProviderRow[],
  shopId: string,
  sides: Sides,
  aesKey: Buffer,
): LlmProvider[] {
  return selectProviders(rows, shopId, sides).llm.flatMap((row) => {
    if (!row.baseUrl || !row.model) return []; // an incomplete row is skipped, never guessed
    const apiKey = row.secretEncrypted
      ? decryptSecret(
          aesKey,
          { table: "ai_providers", rowId: row.id, column: "secret_encrypted" },
          row.secretEncrypted,
        )
      : "none";
    const options = (row.options ?? {}) as ProviderOptions;
    return [
      openAiCompatibleProvider({
        id: row.id,
        external: row.external,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey,
        extraBody: options.extra_body,
      }),
    ];
  });
}
