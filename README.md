# compression-testing

Upload any file, compress it with the right algorithm, and preview the result at different quality tiers — like YouTube's resolution picker, extended to images, audio, and documents. Self-hosted, one Docker Compose stack, no cloud account.

Spec and architecture: [SPEC.md](SPEC.md)

## Run

1. Copy the repo to the server machine.
2. `cp .env.example .env` (defaults match the compose file; change MinIO keys if exposing beyond localhost)
3. `docker compose up -d --build --wait` (first build ~5 minutes, ~1.5 GB image with ffmpeg, Ghostscript, LibreOffice)
4. Open `http://<server-ip>:3000`

## What it does

| Input | Pipeline | Tiers |
|---|---|---|
| JPEG, PNG, WebP, AVIF, TIFF, GIF, BMP, HEIC | sharp | original + 1920w + 960w + 320w (WebP) |
| MP4, MOV, MKV, AVI, WebM | ffmpeg, HLS (4s segments) | original + 1080p + 720p + 480p + poster |
| MP3, WAV, FLAC, OGG, M4A | ffmpeg | original + opus-96k |
| PDF | Ghostscript | original + screen (72dpi) + ebook (150dpi) + print (300dpi) |
| DOCX, XLSX, PPTX | LibreOffice → PDF → Ghostscript | PDF tiers above |
| TXT, JSON, CSV, XML, MD | Brotli q7 | original + br (dropped if <5% saved) |
| anything else | none | original only |

Video plays through hls.js: Auto quality adapts to bandwidth, the gear menu pins a tier (buffer flushes, switch is visible within ~1s, timestamp kept).

## Verify

```
./test/e2e.sh
```

9 checks against a live stack (needs curl, python3, ffmpeg, docker on the host). Prints `passed 9 / 9` when green. Estimated ~9 minutes (the worker-kill recovery test transcodes a 2-minute 1080p video twice).

## Layout

- `src/registry.ts` — the one file to edit for new formats
- `src/pipelines/` — one module per compressor
- `src/worker.ts` — queue loop, state machine, stale-claim recovery
- `src/api.ts` — Fastify API + static frontend
- `public/` — single-page UI, no build step
- `SPEC.md` — full SDD: architecture, domain model, acceptance criteria

Single user, no auth. Keep it off the public internet.
