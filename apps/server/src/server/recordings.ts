import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "../env";

// Voice clips kept to measure and tune listening (D41, D149): only for a shop whose evaluation_consent is on, in the
// private Storage bucket "recordings" of dokaan-dev, where the evaluation tool reads them. Tests replace the store,
// because CI has no Supabase project.

export interface ClipStore {
  save(path: string, wav: Uint8Array): Promise<void>;
}

function supabaseClipStore(): ClipStore {
  const env = serverEnv();
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async save(path, wav) {
      const { error } = await client.storage
        .from("recordings")
        .upload(path, wav, { contentType: "audio/wav", upsert: false });
      if (error) throw new Error(`recording upload failed: ${error.message}`);
    },
  };
}

const holder = globalThis as { __dokaanClipStore?: ClipStore };

export const clipStore = (): ClipStore => (holder.__dokaanClipStore ??= supabaseClipStore());

/** Tests only. */
export function setClipStoreForTests(store: ClipStore | undefined): void {
  holder.__dokaanClipStore = store;
}

/** <shop_id>/live/<yyyy-mm-dd>/<conversation_id>/<turn_id>.wav: one folder per conversation, so it can be replayed in order. */
export function clipPath(shopId: string, conversationId: string, turnId: string, now: Date): string {
  return `${shopId}/live/${now.toISOString().slice(0, 10)}/${conversationId}/${turnId}.wav`;
}
