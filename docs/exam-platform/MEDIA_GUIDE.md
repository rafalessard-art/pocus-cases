# Ultrasound media guide

## Recommended format

**MP4, H.264 (High profile), yuv420p, no audio, `faststart`, original resolution and frame rate.** Every current browser plays it (Chrome, Edge, Safari, Firefox; iOS/iPadOS and Android). At CRF 16–20 a 2–6 second loop is typically 0.5–5 MB with no visible loss of speckle or annotations.

| Source | What to do |
|---|---|
| MP4 (H.264) from the machine or a PACS/teaching-file export | Upload as is, after the de-identification review |
| MOV (QuickTime), AVI, WMV, MKV | Convert with `tools/convert-clips.sh` |
| Animated GIF | Convert. GIF is 256-colour, which posterizes grayscale, and is many times larger |
| DICOM cine (`.dcm`) | Export as MP4/AVI from the machine, PACS or a DICOM viewer (e.g. Horos/OsiriX "Export → Movie"), then convert. DICOM files embed patient headers, so never upload them |
| Still images | PNG (lossless) or high-quality JPEG |

The upload screen refuses formats that will not play everywhere and shows the conversion command.

## Converting (macOS)

```bash
brew install ffmpeg                       # once
tools/convert-clips.sh ~/Desktop/exam-clips/*.mov
tools/convert-clips.sh --crop-top 60 clip.avi     # also remove a 60-px header band
tools/convert-clips.sh --crf 16 --max-seconds 6 long.mov
```

Output goes to `./converted/`, with a table of dimensions, fps, duration, size and SHA-256 for your records. The script:

- re-encodes to H.264 MP4 at near-lossless quality without resizing (only rounding to even pixel dimensions, which H.264 requires);
- **removes all container metadata** (creation time, device, title or comment fields that some machines fill with patient names or MRNs, GPS);
- optionally crops header and footer bands where the machine burns in patient details.

Conversion runs on your computer, not in a serverless function, so large files never pass through a server. Uploads go **directly from the browser to private storage** (resumable for files over 6 MB, so an interrupted upload continues where it stopped).

## De-identification checklist (per clip, before ticking "de-identified")

- [ ] Watch **every frame**. Burned-in text can appear on only part of a loop.
- [ ] No patient name, MRN, health card number, date of birth, accession number, exam date or time, or site or department labels in the image or overlays.
- [ ] No identifiable anatomy (faces, tattoos, distinctive features) in stills or external photos.
- [ ] The file went through `convert-clips.sh` (metadata stripped), or you confirmed it has no metadata.
- [ ] The filename itself has no identifiers. Rename before uploading; media keys like `LUNG-014` are ideal.

Ticking the attestation in the media library records who attested and when. A clip **cannot be published in an exam** until it is both *authorized for educational use* and *attested de-identified*. The database enforces this, not just the screen.

## Organising the library

- **Media key:** a stable, human-readable ID (`CARD-A4C-012`) used by imports and manifests. It is unique and never reused.
- **Domain:** cardiac, lung, gastric, vascular, diaphragm, airway, ocular, fundamentals or other. This drives domain reporting.
- **Source / attribution / licence:** where the clip came from and the permission under which you use it (e.g. "TOH POCUS archive; departmental approval 2026-11"; "POCUS Atlas, CC BY-NC 4.0").
- **Replace, don't overwrite.** "Replace with new version" keeps the old file for every published exam and historical attempt that used it. Uploaded files are never deleted through the app.
- **Archive** hides a clip from pickers without breaking anything that already uses it.

## Storage choice

| | **Supabase Storage (chosen)** | Vercel Blob | S3-compatible (AWS S3 `ca-central-1`, Cloudflare R2…) |
|---|---|---|---|
| Fits the codebase | Same service as the database and auth. One SDK, and access rules are SQL policies next to the exam data | Extra service; private files must stream through Vercel Functions | Extra service and credentials; needs signing code |
| Canadian data residency | ✅ `ca-central-1` | ❌ no Canadian region | ✅ AWS `ca-central-1`; R2 jurisdiction options vary |
| Private access | Private bucket; RLS-checked signed URLs that expire | Private stores via functions or signed URLs | Presigned URLs |
| Video delivery | CDN-backed, HTTP range requests (seeking works) | CDN | CDN optional (CloudFront) |
| Upload of large files | Direct from the browser, resumable (TUS) | Client uploads, multipart | Multipart, presigned |
| Cost at this scale | Included in Pro (100 GB storage, 250 GB egress) | Usage-based | Low, usage-based |
| Migration out | Standard S3-compatible API; bulk export with the CLI | SDK | — |

What browsers allow means **a learner can always copy what they can see.** Signed URLs, `nodownload` and a blocked context menu discourage casual saving and stop the library from being listed or hot-linked. They cannot make copying impossible, and the portal does not claim they do.
