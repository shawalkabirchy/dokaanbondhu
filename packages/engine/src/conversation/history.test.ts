import { describe, expect, it } from "vitest";
import { ANSWER_CHARS, brief, llmHistory, type PastMessage } from "./history";

// The LLM gets only as much of the past as the request needs (spec 9.5, D125, D126). Each case is said both ways,
// Bangla script and Banglish (D96).

// The parts template: its list, with the prices, follows the colon (D95).
const answer =
  "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে: জেনুইন ৩ সেট, ৪,৫০০ টাকা; নন-জেনুইন ৬ সেট, ১,৮০০ টাকা। দুটোই B-3 তাকে।";

describe("history for the LLM", () => {
  it.each([
    { style: "Bangla", question: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড আছে?", next: "দাম কত?" },
    { style: "Banglish", question: "axio 2014 er front brake pad ache?", next: "dam koto?" },
  ])("keeps the user's words and only what an answer was about ($style)", ({ question, next }) => {
    const history: PastMessage[] = [
      { role: "user", text: question },
      { role: "assistant", text: answer },
      { role: "user", text: next },
    ];
    expect(llmHistory(history, { selfContained: false })).toEqual([
      { role: "user", content: question },
      { role: "assistant", content: "এক্সিও ২০১৪-এর সামনের ব্রেক প্যাড দুই রকম আছে…" },
      { role: "user", content: next },
    ]);
  });

  it("keeps a question whole", () => {
    expect(brief("রহিম মোটরস, এক্সিওর সামনের ব্রেক প্যাড --- কয় সেট?")).toBe(
      "রহিম মোটরস, এক্সিওর সামনের ব্রেক প্যাড --- কয় সেট?",
    );
  });

  it("gives none to a request that names its own part and car", () => {
    const history: PastMessage[] = [
      { role: "user", text: "axio 2014 er front brake pad ache?" },
      { role: "assistant", text: answer },
    ];
    expect(llmHistory(history, { selfContained: true })).toEqual([]);
  });

  it("sends at most the last six messages", () => {
    const history: PastMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      text: `${i}`,
    }));
    expect(llmHistory(history, { selfContained: false }).map((message) => message.content)).toEqual([
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });

  it("cuts a long first sentence", () => {
    const long = `${"ক".repeat(ANSWER_CHARS + 40)}।`;
    expect(brief(long)).toHaveLength(ANSWER_CHARS);
    expect(brief(long).endsWith("…")).toBe(true);
  });
});
