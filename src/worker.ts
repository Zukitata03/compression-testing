import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { pipeline as streamPipeline } from "node:stream/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { pool } from "./db.js";
import { s3, BUCKET_ORIGINALS, BUCKET_VARIANTS } from "./s3.js";
import { findSpec } from "./registry.js";
import { pipelineFor, uploadFile, variantKey, deletePrefix } from "./storage.js";
import { ffprobeDuration, ffprobeHeight } from "./pipelines/video.js";
import { withWorkDir, fileSize } from "./pipelines/util.js";
import type { Variant } from "./types.js";

const STALE_CLAIM_SECONDS = 30;
const MAX_ATTEMPTS = 3;
const POLL_MS = 2000;

// Requeue stale claims (crashed worker) and reset their assets.
// Startup recovery: with a single worker, any claimed job whose process died
// is orphaned. Requeue immediately. Stale-claim age handles multi-worker later.
async function requeueStale(): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status='queued', claimed_at=NULL
     WHERE status='claimed' AND claimed_at < now() - interval '${STALE_CLAIM_SECONDS} seconds'`,
  );
  await pool.query(
    `UPDATE assets SET status='uploaded'
     WHERE status='processing'
       AND id IN (SELECT asset_id FROM jobs WHERE status='queued' AND claimed_at IS NULL)`,
  );
}

async function sweepOrphanTmp(): Promise<void> {
  const entries = await readdir("/tmp").catch(() => [] as string[]);
  const { rows } = await pool.query(`SELECT id FROM assets`);
  const live: Record<string, true> = {};
  for (const row of rows) live[row.id as string] = true;
  for (const entry of entries) {
    if (entry.length === 26 && !(entry in live)) {
      await rm(`/tmp/${entry}`, { recursive: true, force: true });
    }
  }
}

async function claimJob(): Promise<{ id: string; asset_id: string } | null> {
  const { rows } = await pool.query(
    `UPDATE jobs SET status='claimed', claimed_at=now(), attempt=attempt+1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status='queued'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, asset_id`,
  );
  return rows[0] ?? null;
}

async function downloadOriginal(assetId: string, destPath: string): Promise<void> {
  const res = await s3.send(new GetObjectCommand({
    Bucket: BUCKET_ORIGINALS, Key: `${assetId}/original`,
  }));
  await streamPipeline(res.Body as NodeJS.ReadableStream, createWriteStream(destPath));
}

async function processJob(jobId: string, assetId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, mime_type, original_bytes FROM assets WHERE id=$1`, [assetId],
  );
  const asset = rows[0];
  if (!asset) {
    await pool.query(`DELETE FROM jobs WHERE id=$1`, [jobId]);
    return;
  }

  await pool.query(`UPDATE assets SET status='processing' WHERE id=$1`, [assetId]);

  const spec = findSpec(asset.mime_type as string);
  const pipeline = spec ? pipelineFor(spec.pipeline) : null;
  const variants: Variant[] = [];

  await withWorkDir(assetId, async (workDir) => {
    const inputPath = `${workDir}/orig`;
    await downloadOriginal(assetId, inputPath);

    if (pipeline && spec) {
      const total = spec.tiers.length;
      const hlsLevels: Array<{ label: string; bandwidth: number; width: number; height: number }> = [];
      for (let i = 0; i < total; i++) {
        const tier = spec.tiers[i];
        await pool.query(
          `UPDATE assets SET progress_tier=$1, progress_total=$2 WHERE id=$3`,
          [i + 1, total, assetId],
        );
        const result = await pipeline(inputPath, tier, workDir);
        if ("skip" in result && result.skip) continue;
        if (result.multiFile) {
          // HLS: upload <label>.m3u8 plus its segments under <label>/ so the
          // playlist can reference siblings by relative name after rewriting.
          const playlistKey = `${assetId}/${tier.label}.m3u8`;
          const names = (await readdir(workDir)).filter((n) => n.startsWith(`${tier.label}_seg`));
          for (const name of names) {
            await uploadFile(`${workDir}/${name}`, `${assetId}/${tier.label}/${name}`, BUCKET_VARIANTS, "video/mp2t");
          }
          const body = names.length
            ? (await readFile(`${workDir}/${tier.label}.m3u8`, "utf8"))
                .replace(new RegExp(`${tier.label}_seg(\\d+)\\.ts`, "g"), `${tier.label}/${tier.label}_seg$1.ts`)
            : "";
          const tmpPlaylist = `${workDir}/${tier.label}_playlist.m3u8`;
          await writeFile(tmpPlaylist, body);
          await uploadFile(tmpPlaylist, playlistKey, BUCKET_VARIANTS, "application/vnd.apple.mpegurl");
          let totalSize = 0;
          for (const n of names) totalSize += await fileSize(`${workDir}/${n}`);
          variants.push({
            label: tier.label,
            sizeBytes: totalSize,
            objectKey: playlistKey,
            mimeType: "application/vnd.apple.mpegurl",
            downloadable: true,
          });
          // hls.js validates RESOLUTION=WxH. The effective tier height is
          // min(tier, source height); width matches ffmpeg's scale=-2 geometry.
          const srcHeight = await ffprobeHeight(inputPath);
          const effHeight = Math.min(Number(tier.params.height ?? 0), srcHeight);
          const duration = await ffprobeDuration(inputPath);
          const bandwidth = duration > 0 ? Math.round((totalSize * 8) / duration) : 1_000_000;
          const width = Math.round((effHeight * 16) / 9 / 2) * 2;
          hlsLevels.push({ label: tier.label, bandwidth, width, height: effHeight });
          continue;
        }
        const key = variantKey(assetId, tier.label, result.ext);
        await uploadFile(result.outPath, key, BUCKET_VARIANTS, result.mimeType);
        variants.push({
          label: tier.label,
          sizeBytes: await fileSize(result.outPath),
          objectKey: key,
          mimeType: result.mimeType,
          downloadable: true,
        });
      }
      if (hlsLevels.length > 1) {
        // Master playlist, highest quality first (YouTube convention).
        const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
        for (const l of [...hlsLevels].sort((a, b) => b.height - a.height)) {
          lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${l.bandwidth},RESOLUTION=${l.width}x${l.height}`);
          lines.push(`${l.label}.m3u8`);
        }
        await writeFile(`${workDir}/master.m3u8`, lines.join("\n") + "\n");
        await uploadFile(`${workDir}/master.m3u8`, `${assetId}/master.m3u8`, BUCKET_VARIANTS, "application/vnd.apple.mpegurl");
      }
    }

    variants.unshift({
      label: "original",
      sizeBytes: Number(asset.original_bytes),
      objectKey: `${assetId}/original`,
      mimeType: asset.mime_type as string,
      downloadable: true,
    });

    await pool.query(
      `UPDATE assets SET status='ready', variants=$1, progress_tier=NULL, progress_total=NULL WHERE id=$2`,
      [JSON.stringify(variants), assetId],
    );
  });

  await pool.query(`DELETE FROM jobs WHERE id=$1`, [jobId]);
}

async function failJob(jobId: string, assetId: string, attempt: number, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (attempt < MAX_ATTEMPTS) {
    await pool.query(`UPDATE jobs SET status='queued', claimed_at=NULL WHERE id=$1`, [jobId]);
    await pool.query(`UPDATE assets SET status='uploaded', error=$1 WHERE id=$2`, [message, assetId]);
  } else {
    await pool.query(`UPDATE assets SET status='failed', error=$1 WHERE id=$2`, [message, assetId]);
    await pool.query(`DELETE FROM jobs WHERE id=$1`, [jobId]);
  }
}

export async function workerLoop(): Promise<void> {
  await requeueStale();
  await sweepOrphanTmp();
  let lastSweep = Date.now();
  for (;;) {
    // A live worker can still orphan a job (ffmpeg child dying without a close
    // event). The stale sweep must run while the worker lives, not only at boot.
    if (Date.now() - lastSweep > 60_000) {
      await requeueStale();
      lastSweep = Date.now();
    }
    const job = await claimJob();
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    try {
      await processJob(job.id, job.asset_id);
    } catch (err) {
      const { rows } = await pool.query(`SELECT attempt FROM jobs WHERE id=$1`, [job.id]);
      await failJob(job.id, job.asset_id, rows[0]?.attempt ?? MAX_ATTEMPTS, err);
    }
  }
}

await workerLoop();
