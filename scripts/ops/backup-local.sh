#!/bin/bash
# Copy local-only work into the encrypted backup image. Reads the sources; never changes them.
#
#   bash scripts/ops/backup-local.sh
#
# Writes /Volumes/POCUS-Backups/local-files/<date>/ and /Volumes/POCUS-Backups/docs/<date>/:
#   - a git bundle of every branch and tag of ~/pocus-cases and ~/pocus-portal (incl. unpushed work)
#   - untracked and ignored files of both checkouts (without node_modules, builds and test output,
#     and without the synthetic local backups, which stay in ~/pocus-portal/.local-backups)
#   - de-identified exam media found in ~/Downloads and ~/Desktop (*deidentified*); raw exports are
#     only counted, never copied
#   - ~/Documents/POCUS-Portal-Private (if present) and the private notes staged in .wp4/project-docs
# A content-free summary (counts and pass/fail) is copied to ~/pocus-portal/.wp4/.
set -euo pipefail
export GIT_OPTIONAL_LOCKS=0
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PORTAL="$(cd "$SELF_DIR/../.." && pwd)"
VOL=/Volumes/POCUS-Backups
[ -d "$VOL/local-files" ] && [ -d "$VOL/docs" ] || { echo "Mount the backup image first: hdiutil attach ~/POCUS-Private/POCUS-Backups.sparsebundle"; exit 1; }
umask 077
STAMP=$(date +%Y-%m-%d-%H%M)
OUT="$VOL/local-files/$STAMP"
DOCS="$VOL/docs/$STAMP"
mkdir -p "$OUT" "$DOCS"
SUM="$OUT/SUMMARY.txt"
: > "$SUM"
say() { echo "$*" | tee -a "$SUM"; }
say "Local backup at $(date '+%Y-%m-%d %H:%M')"

skip='(^|/)(node_modules|dist|test-results|playwright-report|visual-report|\.wp2-validation|\.wp3-validation|\.local-backups|\.wp4)/|(^|/)\.DS_Store$'

for repo in "$HOME/pocus-cases" "$PORTAL"; do
  [ -d "$repo/.git" ] || { say "$repo: not found"; continue; }
  name=$(basename "$repo")
  b="$OUT/$name-all-refs.bundle"
  git -C "$repo" bundle create "$b" --all >/dev/null 2>&1
  if git -C "$repo" bundle verify "$b" >/dev/null 2>&1; then v=verified; else v=NOT-VERIFIED; fi
  branches=$(git -C "$repo" for-each-ref --format='%(refname:short)' refs/heads | tr '\n' ' ')
  unpushed=$(git -C "$repo" log --branches --not --remotes --oneline | wc -l | tr -d ' ')
  say "$name: bundle $v · branches: $branches· commits not on GitHub: $unpushed"
  n=$( (cd "$repo" && git ls-files -z --others | tr '\0' '\n' | grep -Ev "$skip" | grep -c . ) || true)
  if [ "${n:-0}" -gt 0 ]; then
    mkdir -p "$OUT/$name-untracked-and-ignored"
    (cd "$repo" && git ls-files -z --others | tr '\0' '\n' | grep -Ev "$skip" | tr '\n' '\0' | tar --null -T - -cf - ) | tar -xf - -C "$OUT/$name-untracked-and-ignored"
  fi
  say "$name: untracked and ignored files copied: ${n:-0}"
done

# de-identified media only; raw exports stay where they are (counted, not copied)
media=0
while IFS= read -r -d '' f; do
  rel="${f#$HOME/}"
  mkdir -p "$OUT/deidentified-media/$(dirname "$rel")"
  cp -p "$f" "$OUT/deidentified-media/$rel"
  media=$((media + 1))
done < <(find "$HOME/Downloads" "$HOME/Desktop" -maxdepth 3 -type f -iname '*deidentified*' -print0 2>/dev/null)
raw=$(find "$HOME/Downloads" -maxdepth 1 -type d -name 'FusionExport_*' 2>/dev/null | wc -l | tr -d ' ')
say "de-identified media copied: $media · raw QPath export folders left in Downloads (not copied): $raw"

if [ -d "$HOME/Documents/POCUS-Portal-Private" ]; then
  (cd "$HOME/Documents" && tar -cf - POCUS-Portal-Private) | tar -xf - -C "$DOCS"
  say "private documents (~/Documents/POCUS-Portal-Private): $(find "$DOCS/POCUS-Portal-Private" -type f | wc -l | tr -d ' ') files copied"
else
  say "private documents: ~/Documents/POCUS-Portal-Private not found (nothing copied)"
fi
if [ -d "$PORTAL/.wp4/project-docs" ]; then
  mkdir -p "$DOCS/claude-project" && cp -p "$PORTAL/.wp4/project-docs/"* "$DOCS/claude-project/"
  say "claude.ai project notes staged by Claude: $(ls "$DOCS/claude-project" | wc -l | tr -d ' ') copied"
fi

( cd "$OUT" && find . -type f ! -name SHA256SUMS ! -name SUMMARY.txt -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )
( cd "$DOCS" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS ) 2>/dev/null || true
say "files in this backup: $(($(wc -l < "$OUT/SHA256SUMS") + $(wc -l < "$DOCS/SHA256SUMS" 2>/dev/null || echo 0))) · checksums recorded"
mkdir -p "$PORTAL/.wp4" && cp "$SUM" "$PORTAL/.wp4/local-backup-summary-$STAMP.txt"
echo
echo "Saved in $OUT and $DOCS"
