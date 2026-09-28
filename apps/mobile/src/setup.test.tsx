import type { ConnectionView, SchemaView } from "@dokaanbondhu/contracts";
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
          value_scale: 100,
          id_type: null,
          confirmed: false,
          samples: ["৪,৫০০ টাকা"],
          readings: { "1": "৪,৫০,০০০ টাকা", "100": "৪,৫০০ টাকা" },
        },
      ],
    },
  ],
  missing: [],
  warnings: [],
};

function answer(connections: ConnectionView[]) {
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (path === "/setup/connections") return { connections } as never;
    if (path.startsWith("/setup/schema?")) return { schema } as never;
    if (path.startsWith("/setup/reports?")) {
      return {
        reports: {
          connection_id: connection.id,
          stock_value: { available: false, confirmed: false, current_paisa: null },
          see_in_app: ["profit_loss", "cash_book"],
        },
      } as never;
    }
    if (path.startsWith("/setup/schema/") && init?.method === "PUT") return { schema } as never;
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
    expect(await screen.findByText("setup.host", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("setup.save_connection")).toBeTruthy();
  });

  it("offers a money field's two readings, and a tap sends that value scale", async () => {
    answer([connection]);
    await show();
    expect(await screen.findByText("setup.which_price", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("৪,৫০,০০০ টাকা"));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/setup/schema/${schema.entities[0]!.id}`, {
        method: "PUT",
        body: {
          entity: {
            host_table: "parts",
            joins: [],
            row_filters: [],
            fields: [
              {
                concept_field: "retail_price",
                host_table: "parts",
                host_column: "retail_price",
                value_scale: 1,
              },
            ],
          },
        },
      }),
    );
  });

  it("confirms a concept as proposed", async () => {
    answer([connection]);
    await show();
    fireEvent.press(await screen.findByText("setup.confirm", {}, { timeout: 5000 }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(`/setup/schema/${schema.entities[0]!.id}`, {
        method: "PUT",
        body: {},
      }),
    );
  });
});
