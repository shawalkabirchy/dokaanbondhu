import { conversationCreateSchema, type ConversationView } from "@dokaanbondhu/contracts";
import { conversations } from "@dokaanbondhu/platform-db";
import { readBody, route } from "../../../../src/server/route";
import { platform } from "../../../../src/server/singletons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /conversations (any): { channel } -> a new conversation of the caller (spec 8.3). */
export const POST = route({ role: "any" }, async ({ request, caller }) => {
  const body = await readBody(request, conversationCreateSchema);
  const [row] = await platform().withShop(caller.shopId, (tx) =>
    tx
      .insert(conversations)
      .values({ shopId: caller.shopId, userId: caller.userId, channel: body.channel })
      .returning(),
  );
  const conversation: ConversationView = {
    id: row!.id,
    channel: row!.channel as ConversationView["channel"],
    state: row!.state,
    started_at: row!.startedAt.toISOString(),
  };
  return Response.json({ conversation }, { status: 201 });
});
