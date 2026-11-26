#!/bin/bash
# Restore test: rebuild a hosted backup inside a SEPARATE, disposable local Supabase stack.
# Your development stack (ports 54321-54329) and its data are never touched.
#
#   bash scripts/ops/restore-test.sh                # newest backup in /Volumes/POCUS-Backups/hosted
#   bash scripts/ops/restore-test.sh <backup-dir>
#   bash scripts/ops/restore-test.sh --teardown     # stop the disposable stack and delete ITS data only
#
# The disposable stack lives in ~/POCUS-Private/restore-test (config only) and runs on ports 55320-55329
# under the project id "pocus-restore-test". Results go to /Volumes/POCUS-Backups/restore-tests/<date>/,
# and a content-free copy (counts and pass/fail) to ~/pocus-portal/.wp4/.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PORTAL="$(cd "$SELF_DIR/../.." && pwd)"
cd "$PORTAL"
if command -v brew >/dev/null && [ -d "$(brew --prefix node@22 2>/dev/null)/bin" ]; then
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
WORK="$HOME/POCUS-Private/restore-test"
PID=pocus-restore-test
VOL=/Volumes/POCUS-Backups

if [ "${1:-}" = "--teardown" ]; then
  [ -f "$WORK/supabase/config.toml" ] || { echo "No disposable stack found."; exit 0; }
  grep -q "^project_id = \"$PID\"" "$WORK/supabase/config.toml" || { echo "ABORT: $WORK is not the disposable restore stack."; exit 1; }
  read -r -p "Stop the disposable restore stack and delete its data (your development stack is not affected)? [y/N] " a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || { echo "Nothing done."; exit 0; }
  (cd "$WORK" && supabase stop --no-backup)
  echo "Disposable restore stack removed. Backups in the image are unchanged."
  exit 0
fi

[ -d "$VOL/hosted" ] || { echo "Mount the backup image first: hdiutil attach ~/POCUS-Private/POCUS-Backups.sparsebundle"; exit 1; }
BK=${1:-$(ls -1d "$VOL"/hosted/*/ 2>/dev/null | sort | tail -1)}
BK=${BK%/}
for f in roles.sql schema.sql data.sql auth-storage-data.sql MANIFEST.json SHA256SUMS; do
  [ -f "$BK/$f" ] || { echo "ABORT: $BK has no $f"; exit 1; }
done
echo "backup: $BK"
echo "→ checking the backup files against SHA256SUMS…"
(cd "$BK" && shasum -a 256 -c SHA256SUMS --quiet) || { echo "ABORT: the backup files do not match their checksums"; exit 1; }
docker info >/dev/null 2>&1 || bash scripts/local-stack.sh up >/dev/null

echo "→ preparing the disposable stack (separate project id and ports)…"
mkdir -p "$WORK/supabase/templates" && chmod 700 "$HOME/POCUS-Private"
cp supabase/templates/*.html "$WORK/supabase/templates/"
node -e '
  const fs = require("fs");
  let sec = "";
  const out = [];
  for (const line of fs.readFileSync("supabase/config.toml", "utf8").split("\n")) {
    const m = line.match(/^\[([^\]]+)\]/);
    if (m) sec = m[1];
    if (sec.startsWith("functions.")) continue;            // no Edge Functions in the restore stack
    let l = line
      .replace(/^project_id = .*/, `project_id = "${process.argv[1]}"`)
      .replace(/^(\s*(?:port|shadow_port) = )543(\d\d)\b/, (_, a, b) => a + "553" + b)
      .replace(/^(\s*inspector_port = )8083\b/, (_, a) => a + "8093");
    if (/^enabled = true/.test(l) && ["auth.hook.before_user_created", "edge_runtime", "analytics", "db.seed"].includes(sec)) l = "enabled = false";
    out.push(l);
  }
  fs.writeFileSync(process.argv[2], out.join("\n"));
' "$PID" "$WORK/supabase/config.toml"
grep -q '54321\|54322' "$WORK/supabase/config.toml" && { echo "ABORT: development ports still present in the restore config"; exit 1; }

(cd "$WORK" && (supabase status >/dev/null 2>&1 || supabase start >/dev/null))
ENVS=$(cd "$WORK" && supabase status -o env 2>/dev/null)
T_API=$(echo "$ENVS" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')
T_DB=$(echo "$ENVS" | sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')
T_KEY=$(echo "$ENVS" | sed -n -E 's/^(SERVICE_ROLE_KEY|SECRET_KEY)="?([^"]*)"?$/\2/p' | head -1)
case "$T_API" in http://127.0.0.1:55321) ;; *) echo "ABORT: the disposable stack is not on 127.0.0.1:55321 ($T_API)"; exit 1;; esac
case "$T_DB" in *@127.0.0.1:55322/*) ;; *) echo "ABORT: the disposable database is not on port 55322"; exit 1;; esac
CONTAINER="supabase_db_$PID"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || { echo "ABORT: container $CONTAINER not running"; exit 1; }

STAMP=$(date +%Y-%m-%d-%H%M)
OUT="$VOL/restore-tests/$STAMP"
mkdir -p "$OUT"
LOG="$OUT/restore.log"
echo "→ restoring roles, schema and application data (one transaction)…"
if { cat "$BK/roles.sql" "$BK/schema.sql"; echo "SET session_replication_role = replica;"; cat "$BK/data.sql"; } \
   | docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -q >"$LOG" 2>&1; then
  APP=ok
else
  APP=FAILED
fi
echo "→ restoring sign-in accounts and stored-file records (best effort: Auth versions can differ)…"
if { echo "SET session_replication_role = replica;"; cat "$BK/auth-storage-data.sql"; } \
   | docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -q >>"$LOG" 2>&1; then
  AUTH=ok
else
  AUTH=FAILED
fi
echo "→ uploading the stored files and checking every row count and checksum…"
APP_RESTORE="$APP" AUTH_RESTORE="$AUTH" BK="$BK" OUT="$OUT" T_DB="$T_DB" T_API="$T_API" T_KEY="$T_KEY" node scripts/ops/restore-verify.mjs
mkdir -p .wp4 && cp "$OUT/RESTORE-REPORT.txt" ".wp4/restore-report-$STAMP.txt"
echo
cat "$OUT/RESTORE-REPORT.txt"
echo
echo "The disposable stack is still running (Studio: http://127.0.0.1:55323) so you can look around."
echo "When finished: bash scripts/ops/restore-test.sh --teardown"
