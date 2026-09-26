import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/.turbo/",
    "**/.next/",
    "**/dist/",
    "**/coverage/",
    "**/.expo/",
    "**/android/",
    "**/ios/",
    "**/.venv/",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Only packages/platform-db opens the platform database; everything else goes through withShop() (spec 7.3).
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/platform-db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "drizzle-orm/node-postgres",
              message: "Use withShop() from @dokaanbondhu/platform-db (spec 7.3).",
            },
          ],
          patterns: [
            { group: ["@dokaanbondhu/platform-db/*"], message: "Import @dokaanbondhu/platform-db only." },
          ],
        },
      ],
    },
  },
]);
