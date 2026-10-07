import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importOpenApi } from "../src/host/openapi-import";

// The importer's fixture against the live document of the test host's API, which the integration job starts on
// port 4000 (spec 18.3, 18.5; D133). A change in the host's API fails here until the fixture is refreshed from
// GET /api/openapi.json. Only against a local API.

const apiUrl = process.env.GEARGRID_API_URL ?? "";
const isLocal = (() => {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(apiUrl).hostname);
  } catch {
    return false;
  }
})();
if (process.env.CI === "true" && !isLocal) throw new Error("the OpenAPI test needs the API the CI job starts");

const fixture = JSON.parse(
  readFileSync(new URL("../../../tools/fixtures/openapi/geargrid-openapi.json", import.meta.url), "utf8"),
) as unknown;

describe.skipIf(!isLocal)("the test host's live OpenAPI document", () => {
  it("is the importer's fixture, and imports to the same capabilities", async () => {
    const response = await fetch(new URL("/api/openapi.json", apiUrl));
    expect(response.status).toBe(200);
    const live = (await response.json()) as unknown;
    expect(live).toEqual(fixture);
    const hashes = (document: unknown) =>
      importOpenApi(document).capabilities.map((item) => [item.name, item.schemaHash]);
    expect(hashes(live)).toEqual(hashes(fixture));
  });
});
