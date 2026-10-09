import type { AppWordsView, ConnectionView, PaikariPriceView, SchemaView } from "@dokaanbondhu/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import Setup from "../app/(app)/setup/index";
import { api } from "./lib/api";

jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock("./lib/session", () => ({ useMe: () => ({ data: { user: { role: "owner" } } }) }));
// The offline banner checks the server on a timer; the page is tested without it.
jest.mock("./lib/health", () => ({ useHealth: () => ({ online: true, checking: false }) }));
jest.mock("./lib/api", () => ({
  api: jest.fn(),
  errorText: (_error: unknown, _language: string, fallback: string) => fallback,
}));

// The setup page (spec 15.2, 15.8): the connection form when there is none, and the schema review, where a money
// field shows its first sample read both ways and the owner picks the price that is right (D91).

const apiMock = api as jest.MockedFunction<typeof api>;

const connection: ConnectionView = {
  id: "0b8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
  kind: "db",
  label: null,
  dialect: "postgres",
  host: "db.example.com",
  port: 5432,
  database: "postgres",
  username: "reader",
  ssl_mode: "verify-full",
  has_ssl_ca: true,
  base_url: null,
  auth_type: null,
  auth_header: null,
  status: "active",
  last_checked_at: null,
  last_error: null,
  created_at: "2026-09-28T00:00:00.000Z",
};

const schema: SchemaView = {
  connection_id: connection.id,
  entities: [
    {
      id: "7d1f2c3b-4a5e-4f60-8b9c-0d1e2f3a4b5c",
      concept: "Price",
      host_table: "parts",
      joins: [],
      row_filters: [],
      confirmed: false,
      fields: [
        {
          concept_field: "retail_price",
          kind: "money",
          host_table: "parts",
          host_column: "retail_price",
          id_type: null,
          confirmed: false,
          samples: ["৪,৫০০ টাকা"],
        },
      ],
    },
  ],
  missing: [],
  warnings: [],
};

// The app's words (D121, D122): a customer type the word list does not know ("VIP") is asked, "Garage" is recognized;
// a side "R" (rear or right) is asked, "FL" is recognized as front left.
const words: AppWordsView = {
  connection_id: connection.id,
  groups: {
    price_tier: [
      { value: "VIP", count: 4, our: null, decided_by: null },
      { value: "Garage", count: 9, our: "paikari", decided_by: "words" },
    ],
    quality: [],
    position: [
      { value: "R", count: 3, our: null, decided_by: null },
      { value: "FL", count: 2, our: "front left", decided_by: "words" },
    ],
    unit: [],
  },
};

// An app with two trade prices (D146), like test shop B.
const paikari: PaikariPriceView = {
  connection_id: connection.id,
  options: [
    { field: "garage_price", column: "workshop_rate", example: { part: "ব্রেক প্যাড", taka: 4200 } },
    { field: "wholesale_price", column: "dealer_rate", example: { part: "ব্রেক প্যাড", taka: 4000 } },
  ],
  chosen: null,
};

function answer(connections: ConnectionView[]) {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/setup/connections") return { connections } as never;
    if (path.startsWith("/setup/schema?")) return { schema } as never;
    if (path.startsWith("/setup/reports?")) {
      return {
        reports: {
          connection_id: connection.id,
          stock_value: { available: false, confirmed: false, current_taka: null },
          see_in_app: ["profit_loss", "cash_book"],
        },
      } as never;
    }
    if (path.startsWith("/setup/schema/") && init?.method === "PUT") return { schema } as never;
    if (path.startsWith("/setup/app-words")) return { words } as never;
    if (path.startsWith("/setup/paikari-price")) return { paikari } as never;
    throw new Error(`unexpected ${path}`);
  });
}

async function show() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  await render(
    <QueryClientProvider client={client}>
      <Setup />
    </QueryClientProvider>,
  );
}

describe("setup page", () => {
  beforeEach(() => apiMock.mockReset());

  it("shows the connection form when the shop has no database connection yet", async () => {
    answer([]);
    await show();
    expect(await screen.findByText("setup.host", {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.getByText("setup.save_connection")).toBeTruthy();
  });

  it("shows money in whole taka with no second reading, and confirms the concept as proposed (D110)", async () => {
    answer([connection]);
    await show();
    expect(await screen.findByText("৪,৫০০ টাকা", {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByText("৪,৫০,০০০ টাকা")).toBeNull();
    fireEvent.press(screen.getByText("setup.confirm"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/setup/schema/${schema.entities[0]!.id}`, {
        method: "PUT",
        body: {},
      }),
    );
  });

  it("asks the meaning of an app word it does not know, and saves the owner's choice (D121, D122)", async () => {
    answer([connection]);
    await show();
    expect(await screen.findByText("“VIP”", {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.getByText("“R”")).toBeTruthy();
    expect(screen.getAllByText(/setup\.app_words_ask/)).toHaveLength(2);
    expect(screen.getByText(/setup\.our\.position\.front setup\.our\.position\.left/)).toBeTruthy();
    fireEvent.press(screen.getAllByText("setup.our.price_tier.paikari")[0]!);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/setup/app-words", {
        method: "PUT",
        body: { connection_id: connection.id, concept: "price_tier", value: "VIP", our: "paikari" },
      }),
    );
    fireEvent.press(screen.getAllByText("setup.our.position.rear")[0]!);
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/setup/app-words", {
        method: "PUT",
        body: { connection_id: connection.id, concept: "position", value: "R", our: "rear" },
      }),
    );
  });

  it("confirms a concept as proposed", async () => {
    answer([connection]);
    await show();
    fireEvent.press(await screen.findByText("setup.confirm", {}, { timeout: 15_000 }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/setup/schema/${schema.entities[0]!.id}`, {
        method: "PUT",
        body: {},
      }),
    );
  });

  it("asks which of the app's two trade prices is paikari, each with an example, and saves the choice (D146)", async () => {
    answer([connection]);
    await show();
    expect(await screen.findByText("setup.paikari_question", {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.getByText(/^workshop_rate · ব্রেক প্যাড: /)).toBeTruthy();
    await fireEvent.press(screen.getByText(/^dealer_rate · ব্রেক প্যাড: /));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/setup/paikari-price", {
        method: "PUT",
        body: { connection_id: connection.id, field: "wholesale_price" },
      }),
    );
  });
});
