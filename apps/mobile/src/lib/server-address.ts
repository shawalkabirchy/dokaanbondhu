// The server address rules (spec 15.7, D31): https only, except http://localhost in development builds, because
// the laptop server is reached through adb reverse. The address is saved only after /health answers.

export type AddressCheck = { ok: true; url: string } | { ok: false; reason: "invalid" | "https_only" };

export function checkServerAddress(input: string, developmentBuild: boolean): AddressCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (developmentBuild && url.protocol === "http:" && localhost)) {
    return { ok: true, url: url.origin };
  }
  return { ok: false, reason: url.protocol === "http:" ? "https_only" : "invalid" };
}
