import Fastify from "fastify";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import fastifyStatic from "@fastify/static";
import multipartPlugin from "@fastify/multipart";
import { PassThrough } from "node:stream";
import { readFile } from "node:fs/promises";
import { pool, migrate } from "./db.js";
import { ensureBuckets, s3, BUCKET_ORIGINALS, BUCKET_VARIANTS } from "./s3.js";
import { findSpec } from "./registry.js";
import { uploadFile, getObjectStream, deletePrefix } from "./storage.js";
import { ulid } from "./ulid.js";
import type { AssetKind } from "./types.js";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const app = Fastify({ bodyLimit: MAX_UPLOAD_BYTES });
await app.register(multipartPlugin, { limits: { fileSize: MAX_UPLOAD_BYTES } });
await app.register(fastifyStatic, { root: new URL("../public", import.meta.url).pathname });

const SNIFF_PREFIXES: Array<[string, AssetKind]> = [
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
  ["application/pdf", "document"],
];

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".tiff": "image/tiff",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/x-wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".md": "text/markdown",
  ".log": "text/plain",
};

async function sniffKind(mimeType: string, filename: string): Promise<{ kind: AssetKind; mimeType: string }> {
  const ext = filename.includes(".") ? "." + filename.split(".").pop()!.toLowerCase() : "";
  const resolved = EXT_MIME[ext] ?? mimeType;
  for (const [prefix, kind] of SNIFF_PREFIXES) {
    if (resolved.startsWith(prefix)) return { kind, mimeType: resolved };
  }
  if (findSpec(resolved)) return { kind: findSpec(resolved)!.kind, mimeType: resolved };
  return { kind: "other", mimeType: resolved };
}

app.post("/api/assets", async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "multipart file required" });

  const id = ulid();
  const buf = await file.toBuffer();
  const sniffed = await sniffKind(file.mimetype, file.filename);

  await uploadFile(buf, `${id}/original`, BUCKET_ORIGINALS, sniffed.mimeType);
  const size = buf.length;

  await pool.query(
    `INSERT INTO assets (id, original_name, kind, mime_type, original_bytes) VALUES ($1,$2,$3,$4,$5)`,
    [id, file.filename, sniffed.kind, sniffed.mimeType, size],
  );
  await pool.query(`INSERT INTO jobs (id, asset_id) VALUES ($1,$2)`, [ulid(), id]);

  return reply.code(201).send({ id });
});

async function statUploaded(id: string): Promise<number> {
  const res = await s3.send(new HeadObjectCommand({
    Bucket: BUCKET_ORIGINALS, Key: `${id}/original`,
  }));
  return res.ContentLength ?? 0;
}

app.get("/api/assets", async () => {
  const { rows } = await pool.query(
    `SELECT id, original_name, kind, mime_type, original_bytes, status, progress_tier, progress_total, variants, error, created_at
     FROM assets ORDER BY created_at DESC LIMIT 50`,
  );
  return rows.map((r) => ({
    id: r.id,
    originalName: r.original_name,
    kind: r.kind,
    mimeType: r.mime_type,
    originalBytes: Number(r.original_bytes),
    status: r.status,
    progress: r.progress_tier != null ? { tier: r.progress_tier, total: r.progress_total } : null,
    variants: r.variants,
    error: r.error,
  }));
});

app.get("/api/assets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { rows } = await pool.query(
    `SELECT id, original_name, kind, mime_type, original_bytes, status, progress_tier, progress_total, variants, error
     FROM assets WHERE id=$1`, [id],
  );
  if (!rows[0]) return reply.code(404).send({ error: "not found" });
  const r = rows[0];
  return {
    id: r.id,
    originalName: r.original_name,
    kind: r.kind,
    mimeType: r.mime_type,
    originalBytes: Number(r.original_bytes),
    status: r.status,
    progress: r.progress_tier != null ? { tier: r.progress_tier, total: r.progress_total } : null,
    variants: r.variants,
    error: r.error,
  };
});

app.get("/api/assets/:id/files/:label", async (req, reply) => {
  const { id, label: rawLabel } = req.params as { id: string; label: string };
  // hls.js requests the child playlist as "files/1080p.m3u8"; strip the suffix.
  const label = rawLabel.replace(/\.m3u8$/, "");
  const { rows } = await pool.query(`SELECT variants, mime_type FROM assets WHERE id=$1`, [id]);
  if (!rows[0]) return reply.code(404).send({ error: "not found" });

  let key: string;
  let mimeType: string;
  if (label === "original") {
    key = `${id}/original`;
    mimeType = rows[0].mime_type as string;
  } else {
    const variant = (rows[0].variants ?? []).find((v: { label: string }) => v.label === label);
    if (!variant) return reply.code(404).send({ error: "variant not found" });
    key = variant.objectKey;
    mimeType = variant.mimeType;
  }

  const range = req.headers.range;
  try {
    const res = await getObjectStream(BUCKET_VARIANTS, key, range).catch(async (err) => {
      if (label === "original") return getObjectStream(BUCKET_ORIGINALS, key, range);
      throw err;
    });
    if (res.ContentLength != null) reply.header("Content-Length", res.ContentLength);
    if (res.ContentRange) reply.header("Content-Range", res.ContentRange);
    if (res.AcceptRanges) reply.header("Accept-Ranges", res.AcceptRanges);
    reply.header("Content-Type", mimeType);
    reply.code(range && res.ContentRange ? 206 : 200);
    return reply.send(res.Body);
  } catch {
    return reply.code(404).send({ error: "object missing" });
  }
});

// Master playlist for the YouTube-style adaptive player.
app.get("/api/assets/:id/master.m3u8", async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    const res = await getObjectStream(BUCKET_VARIANTS, `${id}/master.m3u8`);
    const chunks: Buffer[] = [];
    for await (const c of res.Body as NodeJS.ReadableStream) chunks.push(c as Buffer);
    // hls.js resolves child playlist URIs against the master URL, so point
    // "<label>.m3u8" at the files endpoint.
    const body = chunks.join("").toString()
      .replace(/^(\w[\w-]*)\.m3u8$/gm, "files/$1.m3u8");
    reply.header("Content-Type", "application/vnd.apple.mpegurl");
    return reply.send(body);
  } catch {
    return reply.code(404).send({ error: "no hls renditions" });
  }
});

// HLS segments: /api/assets/:id/files/1080p/1080p_seg3.ts streams from the
// variants bucket with Range support so hls.js can seek.
app.get("/api/assets/:id/files/:label/:file", async (req, reply) => {
  const { id, label, file } = req.params as { id: string; label: string; file: string };
  if (!/^[A-Za-z0-9]+_seg\d+\.ts$/.test(file) || !/^[a-z0-9]+$/i.test(label)) {
    return reply.code(400).send({ error: "bad segment path" });
  }
  const range = req.headers.range;
  try {
    const res = await getObjectStream(BUCKET_VARIANTS, `${id}/${label}/${file}`, range);
    if (res.ContentLength != null) reply.header("Content-Length", res.ContentLength);
    if (res.ContentRange) reply.header("Content-Range", res.ContentRange);
    reply.header("Content-Type", "video/mp2t");
    reply.header("Accept-Ranges", "bytes");
    reply.code(range && res.ContentRange ? 206 : 200);
    return reply.send(res.Body);
  } catch {
    return reply.code(404).send({ error: "segment missing" });
  }
});

app.delete("/api/assets/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  await deletePrefix(BUCKET_ORIGINALS, `${id}/`);
  await deletePrefix(BUCKET_VARIANTS, `${id}/`);
  await pool.query(`DELETE FROM assets WHERE id=$1`, [id]);
  return reply.code(204).send();
});

await migrate();
await ensureBuckets();
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
