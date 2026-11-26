#!/bin/bash
# WP3 validation on a developer Mac: runs every suite against the LOCAL Supabase
# stack only and writes results to .wp3-validation/ (git-ignored), including the
# reviewer journey in a fresh browser session and screenshots of each perspective.
#
#   cd ~/pocus-portal && bash scripts/wp3-validate.sh
#
# Never touches a hosted project: it aborts unless every URL is on localhost,
# and it never links, pushes or deploys anything.
set -u
cd "$(dirname "$0")/.."
OUT=.wp3-validation
rm -rf "$OUT" && mkdir -p "$OUT/shots"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"
say() { echo "$*" | tee -a "$SUMMARY"; }

# --- Node 22 (Playwright's Chromium install stalls on Node 26) ---------------
if command -v brew >/dev/null && [ -d "$(brew --prefix node@22 2>/dev/null)/bin" ]; then
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
say "== environment ($(date '+%Y-%m-%d %H:%M'))"
say "node $(node -v) · npm $(npm -v) · $(supabase --version 2>/dev/null | head -1 | sed 's/^/supabase CLI /')"
say "playwright: $(npx --no-install playwright --version 2>/dev/null) · chromium cache: $(ls -d ~/Library/Caches/ms-playwright/chromium* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
say "git: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD) · uncommitted: $(git status --porcelain | grep -vc '^??')"
case "$(node -v)" in v22.*) ;; *) say "ABORT: Node 22 is required (brew install node@22)"; exit 1;; esac

# --- local stack --------------------------------------------------------------
# start OrbStack and the local stack if needed (nothing already running is restarted)
bash scripts/local-stack.sh up >"$OUT/local-stack-up.log" 2>&1 || { say "ABORT: could not start the local stack (see $OUT/local-stack-up.log)"; exit 1; }
say "docker: $(docker info --format '{{.ServerVersion}} on {{.OperatingSystem}}' 2>/dev/null || echo 'NOT RUNNING')"
eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|DB_URL|ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|SECRET_KEY|MAILPIT_URL|INBUCKET_URL)=')"
ANON="${ANON_KEY:-${PUBLISHABLE_KEY:-}}"
SERVICE="${SERVICE_ROLE_KEY:-${SECRET_KEY:-}}"
for u in "${API_URL:-}" "${DB_URL:-}"; do
  case "$u" in http://127.0.0.1:*|http://localhost:*|postgresql://*@127.0.0.1:*|postgresql://*@localhost:*) ;;
    *) say "ABORT: not a local URL: ${u%%@*}…"; exit 1;; esac
done
[ -n "$ANON" ] && [ -n "$SERVICE" ] || { say "ABORT: local keys not found in supabase status"; exit 1; }
say "local stack: API $API_URL · DB ${DB_URL##*@} · keys found (not recorded)"
if [ -f supabase/.temp/project-ref ]; then say "note: this folder is linked to a hosted project ($(cat supabase/.temp/project-ref)); every command below still targets the local stack"; fi

export DATABASE_URL="$DB_URL"
run() { # name, command…
  local name=$1; shift
  local t0=$(date +%s)
  "$@" >"$OUT/$name.log" 2>&1
  local rc=$?
  local tests
  tests=$(grep -E 'Tests[[:space:]]|[0-9]+ (passed|failed)' "$OUT/$name.log" | tail -1 | sed 's/^[[:space:]]*//')
  say "$name: $([ $rc -eq 0 ] && echo PASS || echo "FAIL (exit $rc)") ${tests:+— $tests} ($(( $(date +%s) - t0 ))s)"
  return $rc
}

say ""
say "== suites"
run npm-ci npm ci --no-audit --no-fund
# the suites reset the local database: keep a copy of what was there first
run local-backup bash scripts/local-stack.sh backup
run db-reset supabase db reset
run typecheck npm run -s typecheck
run unit npx vitest run portal/src
run db npx vitest run tests/db

# Edge Function with the local origin allowlist (dev server :5173 and the visual-report gateway :4173);
# kept running for the end-to-end reviewer journey
supabase functions serve demo-redeem --env-file supabase/functions/.env.example >"$OUT/functions-serve.log" 2>&1 &
FPID=$!
for i in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: http://127.0.0.1:5173' "$API_URL/functions/v1/demo-redeem")
  [ "$code" = "204" ] && break; sleep 2
done
say "edge function demo-redeem: preflight $code"
export AUTH_STACK_URL="$API_URL" AUTH_ANON_KEY="$ANON" AUTH_SERVICE_KEY="$SERVICE"
run auth npx vitest run tests/auth

# End-to-end suites (lifecycle, sign-in security, reviewer journey), with screenshots and the visual report.
# The visual report resets the local database first; the reviewer suite loads the synthetic fixtures
# (and their synthetic files, into LOCAL Storage).
run e2e-visual npm run -s visual -- --no-open
kill $FPID 2>/dev/null; wait $FPID 2>/dev/null
cp -R visual-report "$OUT/visual-report" 2>/dev/null
cp visual-report/shots/a*.png visual-report/shots/w*.png "$OUT/shots/" 2>/dev/null
cp -R playwright-report "$OUT/playwright-report" 2>/dev/null
grep -E "✘|✓|passed|failed|Error:" "$OUT/e2e-visual.log" | grep -v "^\s*$" | tail -40 > "$OUT/e2e-summary.txt" 2>/dev/null

# Leave the local database with the demonstration fixtures loaded, for exploring by hand
run db-reset-for-demo supabase db reset
STORAGE_URL="$API_URL" SERVICE_ROLE_KEY="$SERVICE" run fixtures node scripts/demo-fixtures.mjs

# Dependencies (lockfile only; nothing is changed)
npm audit --json >"$OUT/audit.json" 2>/dev/null
npm audit --omit=dev --json >"$OUT/audit-prod.json" 2>/dev/null
say "npm audit: all deps $(node -e "const a=require('./$OUT/audit.json').metadata?.vulnerabilities||{};console.log(JSON.stringify(a))") · production only $(node -e "const a=require('./$OUT/audit-prod.json').metadata?.vulnerabilities||{};console.log(JSON.stringify(a))")"

say ""
say "== done. Results: $OUT/summary.txt · report: $OUT/visual-report/index.html"
