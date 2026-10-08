import { fireEvent, render, screen } from "@testing-library/react-native";
import { AssistantBubble, ConfirmSheet, PartCards, ResultTable } from "./chat-ui";
import type { AssistantMessage, ConfirmEvent } from "./lib/chat-store";

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
      confirm: null,
      result: null,
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

// The confirmation sheet (spec 9.9, 15.2): what will be saved, an unsure field in bold, the app's warnings, and Yes or
// No only while it lasts and only on the newest reply.
describe("confirmation sheet", () => {
  const confirm = (secondsLeft: number): ConfirmEvent => ({
    type: "confirm",
    action_id: "0b8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
    text: "Rahim Motors — এক্সিও ২০১৪, সামনের ব্রেক প্যাড, নন-জেনুইন, ২ সেট, ৩,২০০ টাকা, বাকিতে। ঠিক আছে?",
    fields: [
      { label: "কাস্টমার", value: "Rahim Motors", highlight: true },
      { label: "মোট", value: "৩,২০০ টাকা", highlight: false },
    ],
    warnings: ["Rahim Motors-এর বাকি ক্রেডিট লিমিট ছাড়িয়ে যাবে।"],
    expires_at: new Date(Date.now() + secondsLeft * 1000).toISOString(),
  });

  it("shows the fields and warnings, and sends Yes or No", async () => {
    const onDecide = jest.fn();
    const { unmount } = await render(<ConfirmSheet confirm={confirm(45)} active onDecide={onDecide} />);
    expect(screen.getByText("Rahim Motors")).toBeTruthy();
    expect(screen.getByText("৩,২০০ টাকা")).toBeTruthy();
    expect(screen.getByText("Rahim Motors-এর বাকি ক্রেডিট লিমিট ছাড়িয়ে যাবে।")).toBeTruthy();
    await fireEvent.press(screen.getByText("confirm.yes"));
    await fireEvent.press(screen.getByText("confirm.no"));
    expect(onDecide.mock.calls).toEqual([["yes"], ["no"]]);
    await unmount(); // its countdown stops with it
  });

  it("takes no decision on an older reply", async () => {
    await render(<ConfirmSheet confirm={confirm(45)} active={false} onDecide={jest.fn()} />);
    expect(screen.getByText("Rahim Motors")).toBeTruthy();
    expect(screen.queryByText("confirm.yes")).toBeNull();
  });

  it("takes no decision once its time is up", async () => {
    await render(<ConfirmSheet confirm={confirm(-5)} active onDecide={jest.fn()} />);
    expect(screen.queryByText("confirm.yes")).toBeNull();
    expect(screen.getByText("confirm.expired")).toBeTruthy();
  });
});
