#!/usr/bin/env bash
# =============================================================================
# convert-clips.sh — prepare ultrasound loops for the POCUS exam media library.
#
# Converts MOV / AVI / WMV / MKV / GIF / MP4 (any codec ffmpeg can read) into a
# browser-safe H.264 MP4 suitable for every current browser:
#   * H.264 High profile, yuv420p, near-lossless (CRF 18 by default), original
#     resolution and frame rate, no audio
#   * "faststart" so playback begins before the whole file downloads
#   * ALL container metadata removed (creation time, device, GPS, title…)
#   * optional cropping to remove burned-in header/footer bands that may carry
#     patient identifiers
#
# Output goes to ./converted/<name>.mp4 next to each input. A report with
# dimensions, duration, size and SHA-256 is printed for the media manifest.
#
# Usage:
#   tools/convert-clips.sh [options] file1.mov file2.avi …
# Options:
#   --crf N            quality (lower = better; 16–20 recommended; default 18)
#   --crop-top PX      remove PX pixels from the top (e.g. a patient-name banner)
#   --crop-bottom PX   remove PX pixels from the bottom
#   --crop W:H:X:Y     arbitrary crop rectangle (ffmpeg crop syntax)
#   --max-seconds S    keep only the first S seconds
#   --out DIR          output directory (default: ./converted)
#
# Requires ffmpeg + ffprobe (macOS: `brew install ffmpeg`).
#
# IMPORTANT: stripping metadata does NOT remove identifiers burned into the
# pixels. Review every frame of every clip before marking it de-identified.
# =============================================================================
set -euo pipefail

CRF=18; TOP=0; BOTTOM=0; CROP=""; MAXS=""; OUT="converted"
files=()
made=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --crf) CRF="$2"; shift 2 ;;
    --crop-top) TOP="$2"; shift 2 ;;
    --crop-bottom) BOTTOM="$2"; shift 2 ;;
    --crop) CROP="$2"; shift 2 ;;
    --max-seconds) MAXS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) files+=("$1"); shift ;;
  esac
done
command -v ffmpeg >/dev/null || { echo "ffmpeg not found (macOS: brew install ffmpeg)"; exit 1; }
[[ ${#files[@]} -gt 0 ]] || { echo "No input files. Try --help."; exit 1; }
mkdir -p "$OUT"

filters=()
[[ -n "$CROP" ]] && filters+=("crop=$CROP")
if [[ "$TOP" != 0 || "$BOTTOM" != 0 ]]; then filters+=("crop=iw:ih-$TOP-$BOTTOM:0:$TOP"); fi
filters+=("scale=trunc(iw/2)*2:trunc(ih/2)*2")   # H.264 needs even dimensions
filters+=("format=yuv420p")
VF=$(IFS=,; echo "${filters[*]}")

sha() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

printf "%-40s %-11s %-9s %-8s %-10s %s\n" "output" "size(px)" "fps" "sec" "bytes" "sha256"
for f in "${files[@]}"; do
  base=$(basename "${f%.*}")
  ext="${f##*.}"
  dest="$OUT/$base.mp4"
  # two inputs with the same name (clip.mov, clip.avi) must not overwrite each other
  if [[ " ${made[*]-} " == *" $dest "* ]]; then dest="$OUT/$base-$(echo "$ext" | tr 'A-Z' 'a-z').mp4"; fi
  made+=("$dest")
  args=(-hide_banner -loglevel error -y -i "$f")
  [[ -n "$MAXS" ]] && args+=(-t "$MAXS")
  args+=(-map 0:v:0 -an -sn -dn
         -map_metadata -1 -map_chapters -1
         -vf "$VF"
         -c:v libx264 -preset slow -crf "$CRF" -profile:v high -level 4.1
         -movflags +faststart
         -fflags +bitexact -flags:v +bitexact
         "$dest")
  ffmpeg "${args[@]}"
  info=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate:format=duration \
    -of default=nw=1:nk=1 "$dest" | tr '\n' ' ')
  read -r w h fps dur <<< "$info" || true
  printf "%-40s %-11s %-9s %-8.2f %-10s %s\n" "$dest" "${w}x${h}" "$fps" "$dur" "$(wc -c < "$dest" | tr -d ' ')" "$(sha "$dest")"
done
echo
echo "Done. Review every frame for burned-in identifiers before uploading."
