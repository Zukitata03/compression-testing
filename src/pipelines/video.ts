import { execFile as runTierCmd } from "./util.js";
import type { Pipeline } from "../types.js";
import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function ffprobeDuration(path: string): Promise<number> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
    ]);
    return parseFloat(stdout.trim());
  } catch {
    return 0;
  }
}

export async function ffprobeDimensions(path: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0", path,
    ]);
    const [w, h] = stdout.trim().split(",").map(Number);
    return { width: w || 0, height: h || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

export async function ffprobeHeight(path: string): Promise<number> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=height", "-of", "csv=p=0", path,
    ]);
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}


// One ffmpeg process per tier, H.264 + AAC for compatibility (spec section 4).
// HLS output: 4s segments + playlist, so hls.js can switch tiers mid-play (YouTube behavior).
export const video: Pipeline = async (inputPath, tier, workDir) => {
  if (tier.label === "thumb") {
    const outPath = `${workDir}/thumb.jpg`;
    await runTierCmd("ffmpeg", [
      "-y", "-ss", String(tier.params.seek ?? 1), "-i", inputPath,
      "-frames:v", "1", "-q:v", "3", outPath,
    ]);
    return { outPath, mimeType: "image/jpeg", ext: "jpg" };
  }
  const height = Number(tier.params.height ?? 720);
  await runTierCmd("ffmpeg", [
    "-y", "-i", inputPath,
    "-vf", `scale=-2:'min(${height},ih)'`,
    "-c:v", "libx264", "-crf", "23", "-preset", "fast",
    "-c:a", "aac", "-b:a", "128k",
    // Default: half the cores, min 2. A shared server must not donate every
    // core to x264. Override with FFMPEG_THREADS in .env.
    "-threads", String(process.env.FFMPEG_THREADS ?? Math.max(2, Math.floor(cpus().length / 2))),
    "-f", "hls",
    "-hls_time", "4",
    "-hls_playlist_type", "vod",
    "-hls_segment_filename", `${workDir}/${tier.label}_seg%d.ts`,
    `${workDir}/${tier.label}.m3u8`,
  ]);
  return { outPath: `${workDir}/${tier.label}.m3u8`, mimeType: "application/vnd.apple.mpegurl", ext: "m3u8", multiFile: true };
};
