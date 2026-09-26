import { errorBodySchema } from "@dokaanbondhu/contracts";
import { describe, expect, it } from "vitest";
import { appError, errorResponse } from "./errors";

describe("error shape", () => {
  it("answers an AppError with its status, both languages and the details", async () => {
    const response = errorResponse(appError("RATE_LIMITED", 429, { retry_after: 3 }), "req-1", {
      "Retry-After": "3",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    const body = errorBodySchema.parse(await response.json());
    expect(body.error).toEqual({
      code: "RATE_LIMITED",
      message_en: "Too many requests. Please wait a moment.",
      message_bn: "অনেক বেশি অনুরোধ। একটু অপেক্ষা করুন।",
      message_bn_key: "errors.RATE_LIMITED",
      details: { retry_after: 3 },
    });
  });

  it("turns anything unexpected into INTERNAL with the request ID, and nothing else", async () => {
    const response = errorResponse(new Error("password=hunter22 leaked"), "req-2");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("hunter22");
    expect(JSON.parse(text).error).toMatchObject({ code: "INTERNAL", details: { request_id: "req-2" } });
  });
});
