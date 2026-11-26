#!/bin/bash
# Restore test: rebuild a hosted backup inside a SEPARATE, disposable local Supabase stack that is
# reachable from this Mac only. Your development stack (ports 54321-54329) and its data are never touched.
#
#   bash scripts/ops/restore-test.sh                # newest backup in /Volumes/POCUS-Backups/hosted
#   bash scripts/ops/restore-test.sh <backup-dir>
#   bash scripts/ops/restore-test.sh --keep         # leave the disposable stack running afterwards
#   bash scripts/ops/restore-test.sh --teardown     # stop the disposable stack, delete ITS data, verify
#
# Order: start an EMPTY stack on a Docker network whose published ports bind to 127.0.0.1 only →
# verify that (Docker's port table, the Mac's listening sockets, and a connection attempt through
# this Mac's own network address) → only then restore → verify → tear down and verify removal.
# Studio and the mail catcher are not started. Results go to /Volumes/POCUS-Backups/restore-tests/<date>/;
# a content-free copy (counts and pass/fail) goes to ~/pocus-portal/.wp4/.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PORTAL="$(cd "$SELF_DIR/../.." && pwd)"
cd "$PORTAL"
if command -v brew >/dev/null && [ -d "$(brew --prefix node@22 2>/dev/null)/bin" ]; then
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi
WORK="$HOME/POCUS-Private/restore-test"
PID=pocus-restore-test
NET=pocus-restore-local
VOL=/Volumes/POCUS-Backups
STAMP=$(date +%Y-%m-%d-%H%M)
mkdir -p .wp4

teardown() {   # $1 = file for the content-free result
  local f=$1 c v n
  if [ -f "$WORK/supabase/config.toml" ]; then
    grep -q "^project_id = \"$PID\"" "$WORK/supabase/config.toml" || { echo "ABORT: $WORK is not the disposable restore stack."; exit 1; }
    (cd "$WORK" && supabase stop --no-backup >/dev/null 2>&1) || true
  fi
  # anything of this project that the CLI did not remove (only names containing the disposable project id)
  for x in $(docker ps -aq --filter "name=$PID"); do docker rm -f "$x" >/dev/null; done
  for x in $(docker volume ls -q --filter "name=$PID"); do docker volume rm "$x" >/dev/null; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  c=$(docker ps -a --format '{{.Names}}' | grep -c "$PID" || true)
  v=$(docker volume ls --format '{{.Name}}' | grep -c "$PID" || true)
  n=$(docker network ls --format '{{.Name}}' | grep -cx "$NET" || true)
  {
    echo "Teardown of the disposable restore stack at $(date '+%Y-%m-%d %H:%M')"
    echo "  containers left: $c · data volumes left: $v · restore network left: $n"
    if [ "$c$v$n" = "000" ]; then echo "  result: REMOVED — no restored data remains outside the encrypted backup image"
    else echo "  result: NOT FULLY REMOVED — see the counts above"; fi
  } | tee "$f"
  [ "$c$v$n" = "000" ]
}

case "${1:-}" in
  --teardown)
    docker info >/dev/null 2>&1 || { echo "OrbStack is not running, so no disposable stack is running either."; exit 0; }
    read -r -p "Stop the disposable restore stack and delete its data (your development stack is not affected)? [y/N] " a
    [ "$a" = "y" ] || [ "$a" = "Y" ] || { echo "Nothing done."; exit 0; }
    teardown ".wp4/restore-teardown-$STAMP.txt"
    exit $? ;;
esac
KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; shift; fi

[ -d "$VOL/hosted" ] || { echo "Mount the backup image first: hdiutil attach ~/POCUS-Private/POCUS-Backups.sparsebundle"; exit 1; }
BK=${1:-$(ls -1d "$VOL"/hosted/*/ 2>/dev/null | sort | tail -1)}
BK=${BK%/}
for f in roles.sql schema.sql data.sql MANIFEST.json SHA256SUMS; do
  [ -f "$BK/$f" ] || { echo "ABORT: $BK has no $f"; exit 1; }
done
[ -f "$BK/auth-storage-data.sql" ] || [ -f "$BK/auth-data.sql" ] || { echo "ABORT: $BK has no sign-in data dump"; exit 1; }
echo "backup: $BK"
echo "→ checking the backup files against SHA256SUMS…"
(cd "$BK" && shasum -a 256 -c SHA256SUMS --quiet) || { echo "ABORT: the backup files do not match their checksums"; exit 1; }
docker info >/dev/null 2>&1 || bash scripts/local-stack.sh up >/dev/null

if [ -n "$(docker ps -q --filter "name=$PID")" ]; then
  echo "ABORT: a disposable restore stack from an earlier run is still running."
  echo "       Remove it first: bash scripts/ops/restore-test.sh --teardown"
  exit 1
fi

echo "→ preparing the disposable stack (separate project id and ports; no Studio, no mail catcher)…"
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
      .replace(/^(\s*(?:port|shadow_port|smtp_port|pop3_port) = )543(\d\d)\b/, (_, a, b) => a + "553" + b)
      .replace(/^(\s*inspector_port = )8083\b/, (_, a) => a + "8093");
    if (/^enabled = true/.test(l) && ["auth.hook.before_user_created", "edge_runtime", "analytics", "db.seed", "studio", "inbucket"].includes(sec)) l = "enabled = false";
    out.push(l);
  }
  fs.writeFileSync(process.argv[2], out.join("\n"));
' "$PID" "$WORK/supabase/config.toml"
grep -qE '\b543[0-9]{2}\b' "$WORK/supabase/config.toml" && { echo "ABORT: development ports still present in the restore config"; exit 1; }

echo "→ creating a Docker network that publishes ports on 127.0.0.1 only…"
docker network inspect "$NET" >/dev/null 2>&1 \
  || docker network create -o 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1' "$NET" >/dev/null
[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' "$NET")" = "127.0.0.1" ] \
  || { echo "ABORT: the restore network is not bound to 127.0.0.1"; exit 1; }

OUT="$VOL/restore-tests/$STAMP"
mkdir -p "$OUT" && chmod 700 "$OUT"
EXPO="$OUT/EXPOSURE.txt"
fail_exposure() { echo "ABORT: $1 — stopping the empty stack before anything is restored."; cat "$EXPO"; cp "$EXPO" ".wp4/restore-exposure-$STAMP.txt"; teardown ".wp4/restore-teardown-$STAMP.txt" || true; exit 1; }

echo "→ starting the EMPTY disposable stack…"
(cd "$WORK" && supabase start --network-id "$NET" >/dev/null)

echo "→ verifying it is reachable from this Mac only (before restoring anything)…"
{
  echo "Network exposure of the disposable stack at $(date '+%Y-%m-%d %H:%M') (checked before restoring)"
  pub=$(docker ps --filter "name=$PID" --format '{{.Ports}}' | tr ',' '\n' | grep -- '->' | sed 's/^ *//' || true)
  echo "  published ports: $(echo "$pub" | grep -c . || true)"
  bad=$(echo "$pub" | grep -v '^127\.0\.0\.1:' | grep . || true)
  echo "  published on anything other than 127.0.0.1: $(echo "$bad" | grep -c . || true)"
  if [ -n "$bad" ]; then echo "$bad" | sed 's/^/    /'; fi
  ls_all=$(lsof -nP -iTCP:55320-55329 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u || true)
  echo "  listening sockets on 55320-55329: $(echo "$ls_all" | grep -c . || true)"
  ls_bad=$(echo "$ls_all" | grep -vE '^(127\.0\.0\.1|\[::1\]):' | grep . || true)
  echo "  listening on all interfaces or a network address: $(echo "$ls_bad" | grep -c . || true)"
  if [ -n "$ls_bad" ]; then echo "$ls_bad" | sed 's/^/    /'; fi
  if nc -z -G 2 127.0.0.1 55321 >/dev/null 2>&1; then echo "  connection via 127.0.0.1:55321 (control): succeeds"; else echo "  connection via 127.0.0.1:55321 (control): FAILS"; fi
  reach=0; ips=$(ifconfig | awk '/inet /{print $2}' | grep -v '^127\.' || true)
  echo "  this Mac's network addresses tested: $(echo "$ips" | grep -c . || true)"
  for ip in $ips; do for p in 55321 55322 55323 55324 55327; do
    if nc -z -G 2 "$ip" "$p" >/dev/null 2>&1; then reach=$((reach+1)); echo "    reachable through a network address on port $p"; fi
  done; done
  echo "  connections through a network address that succeeded: $reach"
} > "$EXPO" 2>&1
grep -q 'published on anything other than 127.0.0.1: 0$' "$EXPO" || fail_exposure "a port is published beyond localhost"
grep -q 'listening on all interfaces or a network address: 0$' "$EXPO" || fail_exposure "a socket listens beyond localhost"
grep -q 'control): succeeds' "$EXPO" || fail_exposure "the stack is not reachable on 127.0.0.1 (cannot verify)"
grep -q 'network address that succeeded: 0$' "$EXPO" || fail_exposure "the stack is reachable through this Mac's network address"
echo "  localhost only: verified"

ENVS=$(cd "$WORK" && supabase status -o env 2>/dev/null)
T_API=$(echo "$ENVS" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')
T_DB=$(echo "$ENVS" | sed -n 's/^DB_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')
T_KEY=$(echo "$ENVS" | sed -n -E 's/^(SERVICE_ROLE_KEY|SECRET_KEY)="?([^"]*)"?$/\2/p' | head -1)
T_ANON=$(echo "$ENVS" | sed -n -E 's/^(ANON_KEY|PUBLISHABLE_KEY)="?([^"]*)"?$/\2/p' | head -1)
case "$T_API" in http://127.0.0.1:55321) ;; *) fail_exposure "the disposable API is not on 127.0.0.1:55321";; esac
case "$T_DB" in *@127.0.0.1:55322/*) ;; *) fail_exposure "the disposable database is not on 127.0.0.1:55322";; esac
CONTAINER="supabase_db_$PID"
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" || fail_exposure "container $CONTAINER not running"

LOG="$OUT/restore.log"
echo "→ restoring roles, schema and application data (one transaction)…"
if { cat "$BK/roles.sql" "$BK/schema.sql"; echo "SET session_replication_role = replica;"; cat "$BK/data.sql"; } \
   | docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction -q >"$LOG" 2>&1; then
  APP=ok
else
  APP=FAILED
fi
export BK OUT T_DB T_API T_KEY T_ANON CONTAINER
echo "→ restoring sign-in accounts and stored-file records table by table, then signing in as each account…"
AUTH_MODE=restore node scripts/ops/restore-auth.mjs
echo "→ rehearsing the fallback (recreate every account with its original id)…"
AUTH_MODE=fallback node scripts/ops/restore-auth.mjs
echo "→ uploading the stored files and checking every row count and checksum…"
APP_RESTORE="$APP" node scripts/ops/restore-verify.mjs
cat "$OUT/RESTORE-REPORT.txt" "$OUT/AUTH-RECOVERY.txt" "$OUT/AUTH-FALLBACK.txt" "$EXPO" > "$OUT/FULL-REPORT.txt"
cp "$OUT/FULL-REPORT.txt" ".wp4/restore-report-$STAMP.txt"
echo
cat "$OUT/FULL-REPORT.txt"
echo
if [ "$KEEP" = 1 ]; then
  echo "The disposable stack is still running (localhost only). When finished: bash scripts/ops/restore-test.sh --teardown"
else
  echo "→ removing the disposable stack and its data volumes…"
  teardown ".wp4/restore-teardown-$STAMP.txt" || true
fi
