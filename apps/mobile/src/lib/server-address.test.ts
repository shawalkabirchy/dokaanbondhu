import { checkServerAddress } from "./server-address";

describe("server address", () => {
  it("accepts https everywhere and http://localhost only in development builds", () => {
    expect(checkServerAddress("https://abc-3000.proxy.runpod.net/", false)).toEqual({
      ok: true,
      url: "https://abc-3000.proxy.runpod.net",
    });
    expect(checkServerAddress("http://localhost:3100", true)).toEqual({
      ok: true,
      url: "http://localhost:3100",
    });
    expect(checkServerAddress("http://localhost:3100", false)).toEqual({ ok: false, reason: "https_only" });
  });

  it("refuses plain http to any other host, and text that is not an address", () => {
    expect(checkServerAddress("http://192.168.0.5:3100", true)).toEqual({ ok: false, reason: "https_only" });
    expect(checkServerAddress("not an address", true)).toEqual({ ok: false, reason: "invalid" });
    expect(checkServerAddress("ftp://example.com", true)).toEqual({ ok: false, reason: "invalid" });
  });
});
