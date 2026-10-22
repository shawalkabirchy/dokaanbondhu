import type { Reminders } from "@dokaanbondhu/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import i18n from "./lib/i18n";
import { api } from "./lib/api";
import { useDeviceSettings } from "./lib/settings-store";
import { RemindersCard } from "./reminders-card";

// The reminders card (spec 15.2, D194): counts and the first names, in Bangla or English; a tap asks the assistant
// in Bangla or Banglish; nothing to remind, an app that cannot say, or a failed request: no card at all.

jest.mock("./lib/api", () => ({ api: jest.fn() }));
jest.mock("./lib/supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

const mockApi = api as jest.Mock;

/** The app language, switched as the settings page does, inside act. */
const speak = (language: "bn" | "en") =>
  act(async () => {
    useDeviceSettings.setState({ language });
    await i18n.changeLanguage(language);
  });

const both: Reminders = {
  low_stock: { count: 2, more: false, names: ["সেলফ মোটর", "Alternator"] },
  old_dues: { count: 1, more: false, names: ["রহিম মোটরস"], old_taka: 15320 },
};

async function show(answer: () => Promise<unknown>) {
  mockApi.mockImplementation(answer);
  const onAsk = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={client}>
      <RemindersCard onAsk={onAsk} />
    </QueryClientProvider>,
  );
  return onAsk;
}

describe("reminders card", () => {
  beforeEach(async () => {
    mockApi.mockReset();
    await speak("bn");
  });

  it("counts the low parts and old dues in Bangla, and a tap asks in Bangla", async () => {
    const onAsk = await show(async () => both);
    expect(mockApi).toHaveBeenCalledWith("/reminders");
    expect(await screen.findByText("২টি পার্ট কম আছে")).toBeTruthy();
    expect(screen.getByText("সেলফ মোটর, Alternator")).toBeTruthy();
    expect(screen.getByText("১ জনের বাকি ৩০ দিনের বেশি পুরোনো, মোট ১৫,৩২০ টাকা")).toBeTruthy();
    await fireEvent.press(screen.getByText("২টি পার্ট কম আছে"));
    expect(onAsk).toHaveBeenLastCalledWith("কী কী কম আছে?");
    await fireEvent.press(screen.getByText("রহিম মোটরস"));
    expect(onAsk).toHaveBeenLastCalledWith("কার বাকি পুরোনো?");
  });

  it("in English, asks in Banglish, and says when the list goes on", async () => {
    await speak("en");
    const onAsk = await show(async () => ({
      low_stock: { count: 50, more: true, names: ["A", "B", "C"] },
      old_dues: null,
    }));
    await fireEvent.press(await screen.findByText("50+ parts running low"));
    expect(onAsk).toHaveBeenCalledWith("ki ki kom ache?");
    expect(screen.queryByText(/owe from/)).toBeNull();
  });

  it.each([
    ["nothing to remind", async () => ({ low_stock: { count: 0, more: false, names: [] }, old_dues: null })],
    ["an app that keeps neither", async () => ({ low_stock: null, old_dues: null })],
    [
      "a failed request",
      async () => {
        throw new Error("offline");
      },
    ],
  ])("shows no card for %s", async (_case, answer) => {
    await show(answer);
    expect(mockApi).toHaveBeenCalled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0))); // the answer has come
    expect(screen.queryByText("মনে রাখার মতো")).toBeNull();
  });
});
