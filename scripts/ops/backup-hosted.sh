#!/bin/bash
# Back up a HOSTED Supabase project into the encrypted backup image (read-only on the project).
#
#   bash scripts/ops/backup-hosted.sh [project-ref]      # default: the development project
#
# Writes to /Volumes/POCUS-Backups/hosted/<date>-<ref>/ (mount the image first):
#   schema.sql, data.sql (public and other app schemas), auth-storage-data.sql, roles.sql,
#   storage/<bucket>/… (every stored file), MANIFEST.json (row counts, files, checksums),
#   SHA256SUMS, AUTH-CONFIG.md (to complete by hand: Auth settings have no export on Free).
# A content-free summary (counts and pass/fail only) is copied to ~/pocus-portal/.wp4/.
#
# Credentials are asked for in hidden prompts, used for this run only, and never written to disk.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF_DIR/../.."
if command -v brew >/dev/null && [ -d "$(brew --prefix node@22 2>/dev/null)/bin" ]; then
  export PATH="$(brew --prefix node@22)/bin:$PATH"
fi

REF=${1:-ngnggoekezucadlwiomp}
case "$REF" in *[!a-z]*|'') echo "Not a project ref: $REF"; exit 2;; esac
VOL=/Volumes/POCUS-Backups
[ -d "$VOL/hosted" ] || { echo "Mount the backup image first: hdiutil attach ~/POCUS-Private/POCUS-Backups.sparsebundle"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Start OrbStack first (npm run local:up): the database dump runs pg_dump in a container."; exit 1; }

STAMP=$(date +%Y-%m-%d-%H%M)
OUT="$VOL/hosted/$STAMP-$REF"
mkdir -p "$OUT" && chmod 700 "$OUT"
umask 077

echo "1) In Supabase: your project → Connect → Session pooler. Copy the connection string"
echo "   (it shows [YOUR-PASSWORD] where the password goes) and paste it here:"
read -r POOL
case "$POOL" in
  postgresql://postgres.$REF:\[YOUR-PASSWORD\]@*.pooler.supabase.com:5432/postgres*) ;;
  *) echo "That is not the session-pooler string for project $REF (port 5432, with [YOUR-PASSWORD])."; exit 1;;
esac
# The password is checked before anything else runs (3 tries).
for try in 1 2 3; do
  read -rs -p "2) Database password (hidden; from your password manager): " PW; echo
  [ -n "$PW" ] || { echo "   (empty — try again)"; continue; }
  ENC=$(PW="$PW" node -e 'process.stdout.write(encodeURIComponent(process.env.PW))')
  DBURL="${POOL/\[YOUR-PASSWORD\]/$ENC}"
  unset PW ENC
  if DB_URL="$DBURL" node -e '
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
    c.connect().then(() => c.query("select 1")).then(() => c.end()).then(() => process.exit(0),
      (e) => { console.error("   connection failed: " + (/password/i.test(e.message) ? "the password was not accepted" : e.message)); process.exit(1); });
  '; then echo "   password accepted"; break; fi
  DBURL=""
done
[ -n "${DBURL:-}" ] || { echo "Stopped: the database password was not accepted. Reset it under Project Settings → Database, save it in your password manager, then run this again."; rmdir "$OUT" 2>/dev/null; exit 1; }
read -rs -p "3) Secret key (Project Settings → API Keys → secret / service_role; hidden): " SK; echo
[ -n "$SK" ] || { echo "The secret key is needed for the stored files."; exit 1; }

echo "→ database dumps (read-only)…"
supabase db dump --db-url "$DBURL" -f "$OUT/schema.sql" >/dev/null
supabase db dump --db-url "$DBURL" --data-only -f "$OUT/data.sql" >/dev/null
supabase db dump --db-url "$DBURL" --data-only --schema auth,storage -f "$OUT/auth-storage-data.sql" >/dev/null
supabase db dump --db-url "$DBURL" --role-only -f "$OUT/roles.sql" >/dev/null

echo "→ row counts, stored files and checksums…"
DB_URL="$DBURL" SERVICE_KEY="$SK" REF="$REF" OUT="$OUT" node scripts/ops/backup-storage.mjs
unset DBURL SK

( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )

cat > "$OUT/AUTH-CONFIG.md" <<EOF
# Auth configuration of $REF on $STAMP (fill in from the dashboard; no secrets)
Authentication → Sign In / Providers: email enabled? ____  sign-ups allowed? ____  confirm email? ____
Authentication → Emails: OTP length ____  OTP expiry ____  templates customised? ____
Authentication → Passwords: minimum length ____  requirements ____  secure password change ____
Authentication → Multi-Factor: TOTP enroll ____ verify ____
Authentication → URL Configuration: site URL ____  redirect URLs ____
Authentication → Hooks: before-user-created → public.hook_before_user_created? ____
Authentication → Emails → SMTP: custom SMTP? ____ host/sender (no password) ____
Authentication → Rate Limits: emails/hour ____  OTP ____  sign-ins ____
Owner account: email ____  password set? ____  authenticators (names only) ____
Recovery: password manager entry for the DB password ____  for this image ____
EOF

mkdir -p .wp4 && cp "$OUT/SUMMARY.txt" ".wp4/backup-summary-$STAMP-$REF.txt"
echo
cat "$OUT/SUMMARY.txt"
echo
echo "Saved in $OUT"
echo "Next: open $OUT/AUTH-CONFIG.md and fill it in from the dashboard (no passwords)."
