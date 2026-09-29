import { render, screen } from "@testing-library/react-native";
import { AssistantBubble, PartCards, ResultTable } from "./chat-ui";
import type { AssistantMessage } from "./lib/chat-store";

jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

// What a reply shows (spec 15.8): a table event's money cells arrive in whole taka (D110); a part card
// shows stock, price and rack, and says when fitment is not recorded.

describe("reply content", () => {
  it("shows a table's money in taka, with Bangla digits in Bangla", async () => {
    await render(
      <ResultTable
        language="bn"
        table={{
          type: "table",
          title: "বাকি",
          columns: [
            { key: "name", label: "name", kind: "text" },
            { key: "due_balance", label: "due_balance", kind: "money" },
          ],
          rows: [["Rahim Motors", 19200]],
          truncated: false,
        }}
      />,
    );
    expect(screen.getByText("Rahim Motors")).toBeTruthy();
    expect(screen.getByText("১৯,২০০ টাকা")).toBeTruthy();
  });

  it("shows money in taka in English too, and notes a table cut short", async () => {
    await render(
      <ResultTable
        language="en"
        table={{
          type: "table",
          title: "",
          columns: [{ key: "total", label: "total", kind: "money" }],
          rows: [[123457]],
          truncated: true,
        }}
      />,
    );
    expect(screen.getByText("Tk 1,23,457")).toBeTruthy();
    expect(screen.getByText("chat.more_rows")).toBeTruthy();
  });

  it("shows a part card's stock, price and rack, and a missing fitment", async () => {
    await render(
      <PartCards
        language="bn"
        parts={[
          {
            host_part_id: "p1",
            name: "Front brake pad set",
            quality: "genuine",
            unit: "set",
            stock: 3,
            price_taka: { retail: 4500 },
            rack: "B-3",
            fitment_verified: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("chat.stock: ৩ সেট")).toBeTruthy();
    expect(screen.getByText("chat.prices.retail: ৪,৫০০ টাকা")).toBeTruthy();
    expect(screen.getByText("chat.rack: B-3")).toBeTruthy();
    expect(screen.getByText("chat.no_fitment")).toBeTruthy();
  });

  it("shows the working spinner only until the answer's text arrives, though its audio may still come (D101)", async () => {
    const reply = (texts: string[]): AssistantMessage => ({
      kind: "assistant",
      id: "r1",
      turnId: null,
      status: "status.searching",
      texts,
      cards: [],
      tables: [],
      choices: null,
      error: null,
      done: false,
    });
    const props = { language: "bn" as const, newest: true, busy: false, onChoose: () => undefined };
    const { rerender } = await render(<AssistantBubble message={reply([])} {...props} />);
    expect(screen.getByText("status.searching")).toBeTruthy();
    await rerender(<AssistantBubble message={reply(["কোন বছরের নোয়া?"])} {...props} />);
    expect(screen.queryByText("status.searching")).toBeNull();
    expect(screen.getByText("কোন বছরের নোয়া?")).toBeTruthy();
  });
});
