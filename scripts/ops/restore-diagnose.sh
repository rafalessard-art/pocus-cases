#!/bin/bash
# Content-free diagnosis of a restore test: which statements failed and which tables each dump holds.
#
#   bash scripts/ops/restore-diagnose.sh            # newest restore test and newest hosted backup
#
# Reads restore.log and the backup's data dumps INSIDE the encrypted image and writes only error
# classes, table/constraint names, line numbers and statement counts to ~/pocus-portal/.wp4/.
# DETAIL/LINE/CONTEXT lines (which can quote row values) are dropped and quoted text is redacted.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF_DIR/../.."
VOL=/Volumes/POCUS-Backups
[ -d "$VOL/hosted" ] || { echo "Mount the backup image first: hdiutil attach ~/POCUS-Private/POCUS-Backups.sparsebundle"; exit 1; }
RT=$(ls -1d "$VOL"/restore-tests/*/ 2>/dev/null | sort | tail -1); RT=${RT%/}
BK=$(ls -1d "$VOL"/hosted/*/ 2>/dev/null | sort | tail -1); BK=${BK%/}
mkdir -p .wp4
OUTF=".wp4/restore-diagnosis-$(date +%Y-%m-%d-%H%M).txt"
{
  echo "Restore log: $(basename "$RT")   Backup: $(basename "$BK")"
  echo
  echo "== Errors in restore.log (values redacted) =="
  if [ -f "$RT/restore.log" ]; then
    grep -E 'ERROR:|FATAL:' "$RT/restore.log" \
      | sed -E "s/'[^']*'/'…'/g; s/\([^()]*\)=\([^()]*\)/(…)=(…)/g" \
      | cut -c1-200 | head -40 || echo "  (no ERROR lines)"
    echo "  total lines in log: $(wc -l < "$RT/restore.log" | tr -d ' ')"
  else
    echo "  (no restore.log)"
  fi
  for f in data.sql auth-storage-data.sql auth-data.sql storage-data.sql; do
    [ -f "$BK/$f" ] || continue
    echo
    echo "== Tables in $f (statement counts; no contents) =="
    grep -oE '^(INSERT INTO|COPY) +"?[a-z_0-9]+"?\."?[a-z_0-9]+"?' "$BK/$f" \
      | sed -E 's/^(INSERT INTO|COPY) +//; s/"//g' | sort | uniq -c || echo "  (none)"
    echo "  transaction control statements: $(grep -cE '^(BEGIN|COMMIT|START TRANSACTION)' "$BK/$f" || true)"
  done
} > "$OUTF"
chmod 600 "$OUTF"
cat "$OUTF"
echo
echo "Saved (content-free) to $OUTF"
