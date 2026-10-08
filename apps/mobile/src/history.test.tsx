import type { ActionsPage, ActionView, ReplyEvent } from "@dokaanbondhu/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";
import History from "../app/(app)/history";
import { api } from "./lib/api";
import { streamTurn } from "./lib/stream";

jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock("./lib/health", () => ({ useHealth: () => ({ online: true, checking: false }) }));
jest.mock("./lib/api", () => ({ api: jest.fn(), ApiError: class extends Error {} }));
jest.mock("./lib/stream", () => ({ streamTurn: jest.fn() }));
jest.mock("./lib/chat", () => ({
  useChat: (select: (state: { conversationId: string }) => unknown) => select({ conversationId: "conv-1" }),
}));

// The history page (spec 15.2, 15.8): each action with what its confirmation said, its status and who did it, and
// Undo where the server says the caller may undo it now (D38); the undo is sent with the conversation it is asked from,
// and its reply is shown.

const apiMock = api as jest.MockedFunction<typeof api>;
const streamMock = streamTurn as jest.MockedFunction<typeof streamTurn>;

const action = (change: Partial<ActionView>): ActionView => ({
  id: "0b8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
  capability: "record_sale",
  template: "sale",
  text: "Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?",
  fields: [],
  status: "done",
  verify_status: "ok",
  user_name: "Karim",
  conversation_id: "conv-1",
  created_at: "2026-10-08T10:00:00.000Z",
  done_at: "2026-10-08T10:00:05.000Z",
  undone_at: null,
  undo_of: null,
  undo_available: true,
  ...change,
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <History />
    </QueryClientProvider>,
  );
}

describe("history page", () => {
  beforeEach(() => {
    apiMock.mockReset();
    streamMock.mockReset();
  });

  it("lists actions with their status and who did them, with Undo only where allowed", async () => {
    const page: ActionsPage = {
      actions: [
        action({}),
        action({ id: "1b8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e", status: "cancelled", undo_available: false }),
      ],
      next_cursor: null,
    };
    apiMock.mockResolvedValue(page as never);
    await show();
    expect(await screen.findAllByText(page.actions[0]!.text, {}, { timeout: 15_000 })).toHaveLength(2);
    expect(apiMock).toHaveBeenCalledWith("/actions?conversation_id=conv-1");
    expect(screen.getByText("history.status_done")).toBeTruthy();
    expect(screen.getByText("history.status_cancelled")).toBeTruthy();
    expect(screen.getAllByText("history.undo")).toHaveLength(1);
  });

  it("undoes an action from this conversation and shows the reply", async () => {
    apiMock.mockResolvedValue({ actions: [action({})], next_cursor: null } as never);
    streamMock.mockImplementation(async (_path, _body, onEvent: (event: ReplyEvent) => void) => {
      onEvent({ type: "text", seq: 0, text: "আগের কাজটা ফিরিয়ে নেওয়া হয়েছে।", final: false });
      onEvent({ type: "text", seq: 1, text: "Rahim Motors-এর মোট বাকি এখন ১৯,২০০ টাকা।", final: true });
      onEvent({
        type: "action_result",
        action_id: "2b8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
        status: "done",
        undo_available: false,
      });
    });
    await show();
    await fireEvent.press(await screen.findByText("history.undo", {}, { timeout: 15_000 }));
    expect(
      await screen.findByText("আগের কাজটা ফিরিয়ে নেওয়া হয়েছে। Rahim Motors-এর মোট বাকি এখন ১৯,২০০ টাকা।"),
    ).toBeTruthy();
    expect(streamMock).toHaveBeenCalledWith(
      "/actions/0b8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e/undo",
      { conversation_id: "conv-1" },
      expect.any(Function),
    );
  });
});
