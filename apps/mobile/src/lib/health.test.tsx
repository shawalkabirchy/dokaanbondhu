import type { Health } from "@dokaanbondhu/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { markOpened, START_MS, useHealth } from "./health";

// The health check (spec 15.7, D164): a server that answers within 2 minutes of the start shows "starting", never
// "offline"; one that does not answer for 2 minutes, or stops answering after it had answered, shows "offline"; while
// the speech worker is waking, health is asked every 10 s.

jest.mock("./settings-store", () => ({
  useDeviceSettings: (select: (state: { serverUrl: string }) => unknown) =>
    select({ serverUrl: "https://server" }),
}));
jest.mock("./api", () => ({ api: jest.fn() }));

const OK: Health = { status: "ok", version: "1", db: "ok", speech: "unknown", llm: "unknown" };

describe("health", () => {
  /** What the server answers now: a health body, or null while it sleeps (no answer). */
  let answer: Health | null;
  const fetchMock = jest.fn(async () => {
    if (!answer) throw new TypeError("Network request failed");
    return { json: async () => answer } as Response;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
    markOpened();
  });
  afterEach(() => jest.useRealTimers());

  async function start() {
    // No clean-up timer after the test: it would keep Jest running for 5 minutes.
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(() => useHealth(), { wrapper });
  }
  const wait = (ms: number) => act(async () => void (await jest.advanceTimersByTimeAsync(ms)));

  it("says starting, never offline, while the server takes a minute to wake, then online", async () => {
    answer = null;
    const { result } = await start();
    for (let second = 0; second < 60; second++) {
      await wait(1000);
      if (!result.current.checking) {
        expect(result.current.online).toBe(false);
        expect(result.current.starting).toBe(true);
      }
    }
    answer = OK;
    await wait(6000); // asked again within 5 s
    expect(result.current.online).toBe(true);
    expect(result.current.starting).toBe(false);
  });

  it("says offline when the server has not answered for 2 minutes", async () => {
    answer = null;
    const { result } = await start();
    await wait(START_MS + 10_000);
    expect(result.current.online).toBe(false);
    expect(result.current.starting).toBe(false);
  });

  it("says offline, not starting, when a server that had answered stops answering", async () => {
    answer = OK;
    const { result } = await start();
    await wait(100);
    expect(result.current.online).toBe(true);
    answer = null;
    await wait(63_000); // the next check after 60 s, and its second try 2 s later (D82)
    expect(result.current.online).toBe(false);
    expect(result.current.starting).toBe(false);
  });

  it("asks every 10 s while the speech worker is waking, every 60 s once it is ready", async () => {
    answer = { ...OK, speech: "waking" };
    const { result } = await start();
    await wait(100);
    expect(result.current.speechWaking).toBe(true);
    const before = fetchMock.mock.calls.length;
    await wait(30_000);
    expect(fetchMock.mock.calls.length - before).toBe(3);
    answer = { ...OK, speech: "ok" };
    await wait(10_000);
    expect(result.current.speechWaking).toBe(false);
    const ready = fetchMock.mock.calls.length;
    await wait(30_000);
    expect(fetchMock.mock.calls.length).toBe(ready);
  });
});
