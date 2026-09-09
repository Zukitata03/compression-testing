# Compression Testing — Spec-Driven Development

Status: draft for review
Date: 2026-09-08
Owner: zukitata03

## 1. What this is

A self-hosted compression testing rig. Upload any file. The system compresses it with the best method for its format, generates preview tiers at different resolutions, and plays or previews every tier in the browser. Think YouTube's resolution picker, extended to images, audio, and documents.

The whole stack packs into Docker Compose. Clone the repo on any server machine, run `docker compose up`, done. No cloud account needed.

## 2. Who it is for

One user, no login, on a private server. Files are private by unlisted ID. There is no auth in the MVP. The API listens on the local network only. Treat the server as trusted.

## 3. Goals

1. Upload a file through a minimal web UI.
2. Compress it with the right algorithm for its format, per the research in `../Compress.md`.
3. Generate resolution tiers the user can switch between, like the YouTube quality menu.
4. Preview or play every tier in the browser. No downloads needed to check quality.
5. Show compression stats. Original size, compressed size, percent saved, per tier.
6. Run entirely in Docker Compose on the server machine.

## 4. Non-goals (MVP)

- No auth, no multi-user, no quotas.
- No CDN. Presigned MinIO URLs or API-proxied streams only.
- No adaptive streaming (HLS/DASH). Fixed MP4 tiers the user picks manually.
- No AV1 or HEVC encode. H.264 for compatibility. HEVC/AV1 is a later experiment flag.
- No distributed workers. One worker container, one job at a time per queue slot.
- No editing. No re-upload, no rename, no share links in v1. Delete is in (it is one endpoint).

## 5. Architecture

Five concerns, four containers, one image.

```
┌────────────┐     ┌──────────────────────────────┐
│  Browser   │────▶│  api (Fastify + static FE)   │
└────────────┘     └──────┬───────────────┬───────┘
                          │ jobs table    │ S3 API
                   ┌──────▼──────┐  ┌─────▼─────┐
                   │  postgres   │  │   minio   │
                   └──────▲──────┘  └─────▲─────┘
                          │ SELECT..SKIP   │
                   ┌──────┴───────────────┴───────┐
                   │  worker (same image, own cmd)│
                   │  sharp / ffmpeg / gs / soffice│
                   └──────────────────────────────┘
```

**One Docker image, two services.** `api` and `worker` share a Node.js + TypeScript image that also carries `ffmpeg`, `ghostscript`, and `libreoffice`. The image is large (about 1.5 GB) but it exists once and both services use it. Compose sets a different `command` per service.

**Postgres is the queue.** A `jobs` table with `SELECT ... FOR UPDATE SKIP LOCKED` replaces Redis + BullMQ. One fewer container, and Postgres is already there for asset metadata. The worker polls every 2 seconds. For a single-user rig this is more than enough throughput.

**MinIO is the object store.** S3-compatible API matches the code in `Compress.md` and swaps to real S3 later by changing two environment variables. Buckets: `originals` and `variants`.

**The API serves the frontend.** Fastify serves static HTML + JS. No nginx container, no build step, no framework. One page.

### Container contract

```yaml
# docker-compose.yml (shape, final file in repo root)
services:
  postgres:  # postgres:16-alpine, volume pgdata, healthcheck pg_isready
  minio:     # minio/minio, volume miniodata, healthcheck /minio/health/ready
  api:       # build ., command node dist/api.js, depends_on postgres+minio healthy
  worker:    # build ., command node dist/worker.js, depends_on postgres+minio healthy
             # shm_size: 1gb (ffmpeg needs it), volume worker-tmp:/tmp
```

Environment (single `.env`): `DATABASE_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_ORIGINALS`, `S3_BUCKET_VARIANTS`, `PORT`.

## 6. Domain model

Two tables and one registry. The registry is the important part. Per format, it declares the compression pipeline and the tier ladder. Code reads the registry. No format-specific `switch` statements scattered around.

### 6.1 Asset

```ts
type AssetKind = "image" | "video" | "audio" | "document" | "text" | "other";
type AssetStatus = "uploaded" | "processing" | "ready" | "failed";

interface Asset {
  id: string;            // ulid, primary key
  originalName: string;
  kind: AssetKind;       // from format registry, sniffed from content not extension
  mimeType: string;
  originalBytes: number;
  status: AssetStatus;   // state machine, see 8.1
  variants: Variant[];
  error?: string;
}

interface Variant {
  label: string;         // "original" | "1920w" | "720p" | "ebook" | "opus-96k"
  sizeBytes: number;
  objectKey: string;     // in the variants bucket, or original in originals bucket
  mimeType: string;
  downloadable: boolean; // tiers yes, previews like thumbnails yes too; "original" yes
}
```

### 6.2 Job

```ts
interface Job {
  id: string;            // ulid
  assetId: string;
  attempt: number;       // max 3, then the asset goes to "failed"
  status: "queued" | "claimed" | "done" | "failed";
  claimedAt?: Date;      // stale claim (claimedAt older than 30 min) is requeueable
}
```

### 6.3 Format registry (the core table)

```ts
interface FormatSpec {
  match: (mime: string) => boolean;
  kind: AssetKind;
  pipeline: PipelineId;       // which compressor runs
  tiers: TierSpec[];          // the resolution ladder
  keepOriginal: boolean;      // true unless the original is replaceable
}

interface TierSpec {
  label: string;              // what the UI shows in the picker
  params: Record<string, unknown>;  // sharp/ffmpeg/gs options
}
```

The pipeline is a pure function per type: `(inputPath, tierParams) => Promise<{ outPath, mimeType }>`. Pipelines are mechanical. All format knowledge lives in the registry table. Adding FLAC support is one registry row, not a new branch in four files.

## 7. Format support matrix

Tier labels are user-facing strings in the quality picker, same position YouTube puts "1080p".

| Input | Pipeline | Tiers | Original kept |
|---|---|---|---|
| JPEG, PNG, WebP, AVIF, TIFF, GIF, BMP, HEIC | `sharp` re-encode | `original` + 1920w + 960w + 320w (WebP, q80) | yes |
| MP4, MOV, MKV, AVI, WebM | `ffmpeg` H.264 + AAC | `original` + 1080p + 720p + 480p + `thumb` (JPG poster) | yes |
| MP3, WAV, FLAC, OGG, M4A | `ffmpeg` Opus | `original` + `opus-96k` | yes |
| PDF | `ghostscript` | `original` + `screen` (72dpi) + `ebook` (150dpi) + `print` (300dpi) | yes |
| DOCX, XLSX, PPTX | `soffice` → PDF, then ghostscript | as PDF above, plus the converted PDF as `original` | yes |
| TXT, JSON, CSV, LOG, XML | Node `zlib` brotli q7 | `original` + `br` (lossless, stored compressed) | yes |
| Anything else | none | `original` only, download link | yes |

Rules from `Compress.md` the registry enforces:

- Never gzip/zstd an already-compressed container. The `br` tier applies to text formats only.
- Re-encode of a JPEG always comes from the original bytes, never from a previous tier. One lossy generation maximum.
- Adaptive check for the `br` tier. If brotli does not save at least 5 percent, the tier is dropped and the UI shows "no gain".

## 8. Worker pipeline

### 8.1 Asset state machine

```
uploaded ──▶ processing ──▶ ready
                 │
                 └──▶ failed
```

The transition is driven only by the worker. The API creates an asset in `uploaded`, inserts a job, and never touches `status` again. This makes requeueing safe: a crashed worker leaves `processing`, the stale-claim sweep resets it to `uploaded` with a fresh job, and the rerun converges. Variants are written to `variants/<assetId>/<label>.<ext>` keys. Rewriting the same key is a no-op for MinIO, so a partial rerun heals itself.

### 8.2 Job loop

```
claim job (SKIP LOCKED)
  set asset processing
  download original to /tmp/<assetId>/orig (stream)
  look up FormatSpec by kind
  for each tier: run pipeline, stat output, upload to variants bucket
  write Variant[] + status ready
  delete job, rm -rf /tmp/<assetId>
on error: attempt < 3 ? requeue : asset failed + error message
```

Video runs tiers sequentially in one ffmpeg process per tier. A 30-minute 1080p upload at preset `fast` takes roughly 10 to 20 minutes on a 4-core box. The UI polls `GET /api/assets/:id` every 3 seconds while status is `processing` and shows the current tier. Tier progress is a `progress` field on the asset: which tier index is running out of how many.

## 9. API

| Method | Path | Returns |
|---|---|---|
| POST | `/api/assets` | multipart upload. 201 with `{id}`. Max 2 GB. |
| GET | `/api/assets` | list, newest first, 50 per page |
| GET | `/api/assets/:id` | asset manifest with variants and progress |
| GET | `/api/assets/:id/files/:label` | stream the variant, correct Content-Type, supports Range for video and audio |
| DELETE | `/api/assets/:id` | removes DB rows and both buckets' objects |

Upload rejects nothing by format. Unknown formats land in the `other` kind and get `original` only.

Range requests matter. Without them, seeking in `<video>` and `<audio>` breaks. The endpoint streams from MinIO with `GetObject` range params, it never buffers whole files.

## 10. Frontend

One static page, no framework, no build step. The reference is the simple file-list UI you showed. Layout:

- Left column. Upload box on top, file list below. Each row shows name, kind icon, size, status chip.
- Right pane. The viewer. Image, video player, audio player, PDF embed, or text view. Quality picker at the top right of the viewer when the asset has more than one tier. Stats strip under the viewer shows per-tier size and percent saved.

The quality picker switches the `<img src>`, `<source>` of the `<video>`, or the PDF object. On video switch, preserve the current timestamp. That is the one piece of FE logic that needs care. Everything else is fetch and render.

PDF preview uses `<embed>` with the browser's native viewer. Text preview fetches the `original` tier.

## 11. Repository layout

```
compression-testing/
├── SPEC.md               # this file
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── src/
│   ├── api.ts            # Fastify server, serves FE + API
│   ├── worker.ts         # job loop
│   ├── db.ts             # migrations + pg pool
│   ├── s3.ts             # MinIO client
│   ├── registry.ts       # FormatSpec table (the one file to edit for new formats)
│   ├── pipelines/
│   │   ├── image.ts      # sharp
│   │   ├── video.ts      # ffmpeg
│   │   ├── audio.ts      # ffmpeg
│   │   ├── pdf.ts        # ghostscript
│   │   ├── office.ts     # soffice + pdf
│   │   └── text.ts       # brotli
│   └── types.ts          # Asset, Variant, Job, FormatSpec
├── public/
│   ├── index.html
│   └── app.js
└── test/
    └── e2e.sh            # acceptance script, see 13
```

## 12. Implementation sequence

Each step ends in something checkable. Do not advance until the current step is green.

1. Scaffold. Compose with postgres + minio up, migrations applied, healthchecks pass. Check: `docker compose ps` all healthy.
2. Upload + list + original download. No compression. Check: curl upload, curl download, byte-identical.
3. Image pipeline + variants + manifest. Check: sharp tiers in MinIO, manifest JSON correct.
4. Worker queue + state machine + requeue. Check: kill the worker mid-job, restart, asset reaches `ready`.
5. Video + audio pipelines. Check: 1080p/720p/480p play in a browser, seek works.
6. PDF + office pipelines. Check: docx converts, three PDF tiers open.
7. Text pipeline. Check: br tier smaller, adaptive 5 percent rule drops it on already-tight input.
8. Frontend page. Check: upload → poll → preview → switch tiers in the browser.
9. Acceptance script. `test/e2e.sh` runs the full flow with curl.

## 13. Acceptance criteria

`test/e2e.sh` runs against a live stack and passes all of these.

1. Upload a 4000px JPEG. Manifest contains four variants. The 320w variant is under 10 percent of original size.
2. Upload an H.264 MP4. Three video tiers plus a poster thumbnail exist. All three play. Range request on 720p returns 206.
3. Upload a WAV. `opus-96k` variant is under 15 percent of original size and plays.
4. Upload a scanned PDF. `screen` tier is smaller than `print` tier. All tiers open as PDF.
5. Upload a DOCX. A converted PDF exists as `original` with three ghostscript tiers.
6. Upload a JSON log. `br` variant is smaller than 30 percent of original.
7. Kill the worker container during a video job. Restart it. The asset reaches `ready` without manual cleanup.
8. Delete an asset. Both buckets no longer list any object with that ID prefix.

## 14. Open decisions

- HEVC as an experiment flag (`FFMPEG_CODEC=libx265`) is deferred until H.264 tiers work end to end.
- Animated GIF handling (WebP animated vs first-frame poster) is not decided. MVP treats GIF as a still image and the `original` tier preserves animation. Fine until it isn't.
- Cleanup of orphaned `/tmp` dirs after a hard crash: the worker sweeps `/tmp` for dirs without a live job at startup. Designed, not yet spec-critical.
