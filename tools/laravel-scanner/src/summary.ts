import type { ScannerSummary } from "@dokaanbondhu/contracts";
import { SKIPPED } from "./files";

// The summary as the owner reads it before saying yes (spec 16.3): every route, its parameters and its auth, what
// was never opened, and the routes not read.

const AUTH: Record<string, string> = {
  session: "session sign-in",
  bearer: "bearer token",
  none: "no sign-in",
};

export function summaryText(summary: ScannerSummary): string {
  const lines = [
    `DokaanBondhu Laravel scanner ${summary.scanner_version}`,
    `Files read: ${summary.scanned_files}. Never opened: ${SKIPPED.join(", ")}`,
    "",
    `Routes found (${summary.routes.length}):`,
  ];
  for (const route of summary.routes) {
    lines.push(`  ${route.method.padEnd(6)} ${route.path}   [${AUTH[route.auth]}]   ${route.handler}`);
    const path = route.params.filter((param) => param.location === "path");
    if (path.length)
      lines.push(
        `         path: ${path.map((param) => (param.references ? `${param.name} → ${param.references.table}` : param.name)).join(", ")}`,
      );
    if (route.validation) lines.push(`         ${route.validation}`);
  }
  const notRead = summary.skipped.filter((entry) => !SKIPPED.includes(entry));
  if (notRead.length) lines.push("", "Routes not read:", ...notRead.map((entry) => `  ${entry}`));
  lines.push("", "Only this summary is uploaded: no source code, no .env, no data from your database.");
  return lines.join("\n");
}
