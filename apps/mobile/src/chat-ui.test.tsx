import { render, screen } from "@testing-library/react-native";
import { PartCards, ResultTable } from "./chat-ui";

jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

// What a reply shows (spec 15.8): a table event's money cells arrive in paisa and are shown in taka; a part card
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
          rows: [["Rahim Motors", 1920000]],
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
          rows: [[12345650]],
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
            price_paisa: { retail: 450000 },
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
});
