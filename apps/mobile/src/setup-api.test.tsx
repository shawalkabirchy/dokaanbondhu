import type { CapabilityView, ConnectionView, FeaturesView } from "@dokaanbondhu/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { api } from "./lib/api";
import { ApiSetup } from "./setup-api";

jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));
jest.mock("./lib/api", () => ({
  api: jest.fn(),
  errorText: (_error: unknown, _language: string, fallback: string) => fallback,
}));

// Setup, the API half (spec 15.2, 15.8; D134): the form when there is no API connection; with one, the actions found in
// its description (never an undo-only one, D52), each switched on, its fields confirmed and its role chosen through
// the server, which refuses one the sandbox has not verified; and the feature list to confirm.

const apiMock = api as jest.MockedFunction<typeof api>;

const connection: ConnectionView = {
  id: "1c8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
  kind: "api",
  label: null,
  dialect: null,
  host: null,
  port: null,
  database: null,
  username: null,
  ssl_mode: null,
  has_ssl_ca: false,
  base_url: "https://shop.example.com",
  auth_type: "api_key",
  auth_header: "X-Api-Key",
  status: "active",
  last_checked_at: null,
  last_error: null,
  created_at: "2026-10-08T00:00:00.000Z",
};

const capability = (change: Partial<CapabilityView>): CapabilityView => ({
  id: "2c8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
  connection_id: connection.id,
  name: "record_sale",
  description: "Record a sale",
  kind: "write",
  http_method: "POST",
  path: "/api/v1/sales",
  source: "openapi",
  schema_hash: "h",
  required_role: "staff",
  template: "sale",
  enabled: false,
  verified_at: "2026-10-08T00:00:00.000Z",
  dry_run: true,
  compensation: null,
  read_back: null,
  is_compensation: false,
  params: [
    {
      id: "3c8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
      path: "items[].part_id",
      location: "body",
      type: "string:uuid",
      required: true,
      enum_values: null,
      entity_concept: "Part",
      semantic_slot: "items",
      safety_critical: true,
      spoken_map: null,
      confirmed: false,
    },
  ],
  ...change,
});

const features: FeaturesView = {
  connections: [
    {
      connection_id: connection.id,
      label: null,
      features: { openapi: "/api/openapi.json", dry_run: "?dry_run=true" },
      confirmed_at: null,
    },
  ],
};

async function show(connections: ConnectionView[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  await render(
    <QueryClientProvider client={client}>
      <ApiSetup connections={connections} />
    </QueryClientProvider>,
  );
}

describe("setup, API half", () => {
  beforeEach(() => apiMock.mockReset());

  it("shows the API connection form when there is none", async () => {
    await show([]);
    expect(screen.getByText("setup.api_base_url")).toBeTruthy();
    expect(screen.getByText("setup.api_auth_key")).toBeTruthy();
  });

  it("lists the actions without undo-only ones, confirms fields, switches one on and confirms the features", async () => {
    const sent: { path: string; body?: unknown }[] = [];
    apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method) sent.push({ path, body: init.body });
      if (path.startsWith("/setup/capabilities?"))
        return {
          capabilities: [
            capability({}),
            capability({
              id: "4c8c1f7e-6a55-4c1e-9d3e-2f4a6b7c8d9e",
              name: "void_sale",
              is_compensation: true,
            }),
          ],
        } as never;
      if (path === "/setup/features" && !init?.method) return features as never;
      return {} as never;
    });
    await show([connection]);
    expect(await screen.findByText("record_sale", {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByText("void_sale")).toBeNull();
    expect(screen.getByText("setup.action_verified")).toBeTruthy();
    await fireEvent.press(screen.getByText("setup.action_confirm_fields"));
    await fireEvent(screen.getByLabelText("setup.action_enabled"), "valueChange", true);
    expect(await screen.findByText("setup.features_detected")).toBeTruthy();
    await fireEvent.press(screen.getByText("setup.confirm"));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          path: `/setup/capabilities/${capability({}).id}`,
          body: { params: [{ path: "items[].part_id", confirmed: true }] },
        },
        { path: `/setup/capabilities/${capability({}).id}`, body: { enabled: true } },
        {
          path: "/setup/features",
          body: { connection_id: connection.id, features: features.connections[0]!.features },
        },
      ]),
    );
  });

  it("shows the server's refusal when an action is switched on before the sandbox verified it", async () => {
    apiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/setup/capabilities?"))
        return { capabilities: [capability({ verified_at: null, params: [] })] } as never;
      if (path === "/setup/features") return features as never;
      if (init?.method === "PATCH") throw new Error("CAPABILITY_NOT_VERIFIED");
      return {} as never;
    });
    await show([connection]);
    expect(await screen.findByText("setup.action_unverified", {}, { timeout: 15_000 })).toBeTruthy();
    await fireEvent(screen.getByLabelText("setup.action_enabled"), "valueChange", true);
    expect(await screen.findByText("common.error")).toBeTruthy();
  });
});
