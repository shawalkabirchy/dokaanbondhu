#!/usr/bin/env bash
# The Laravel scanner's end-to-end run (spec 16.4, 20 step 7; D182): builds the scanner's one file, starts the test
# backend afresh (a Laravel app over test shop B's MySQL tables, and a throwaway platform database), and runs the
# server's end-to-end test against it: the scan in the app's folder, the upload with a one-time token, the sandbox
# check through the session sign-in, and a chat sale saved in the app's MySQL and undone. Laptop only: every database
# it uses is one of compose.yaml's containers, never the real ones (the addresses below win over .env.local).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"

export PLATFORM_MIGRATION_DATABASE_URL=postgres://postgres:e2e-platform@127.0.0.1:5434/platform
export PLATFORM_API_PASSWORD=e2e-platform-api
export PLATFORM_ADMIN_PASSWORD=e2e-platform-admin
export PLATFORM_DATABASE_URL=postgres://platform_api:e2e-platform-api@127.0.0.1:5434/platform
export PLATFORM_ADMIN_DATABASE_URL=postgres://platform_admin:e2e-platform-admin@127.0.0.1:5434/platform

compose="$here/compose.yaml"
# Docker on Windows needs a Windows path when node passes it on.
if command -v cygpath > /dev/null; then compose="$(cygpath -w "$compose")"; fi

echo "== the scanner's one file"
(cd "$repo/tools/laravel-scanner" && npm run build)

echo "== the test backend and its databases, afresh"
docker compose -f "$compose" down -v --remove-orphans
docker compose -f "$compose" up -d --build --wait
docker compose -f "$compose" exec -T app php artisan migrate --force --seed

echo "== the platform database"
cd "$repo"
docker compose -f "$compose" exec -T platform psql -q -U postgres -d platform -v ON_ERROR_STOP=1 \
  < packages/platform-db/bootstrap.sql
npm run db:migrate
npm run db:roles

echo "== the end-to-end test"
LARAVEL_TEST_BACKEND=http://127.0.0.1:8081 LARAVEL_TEST_COMPOSE="$compose" \
  npx vitest run --config vitest.integration.config.ts apps/server/test/scanner-e2e.integration.test.ts
