import { mkdir, rm, stat } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { Pipeline, TierSpec } from "../types.js";

// Hard ceiling per encode step. ffmpeg at preset fast on this workload finishes
// well under it; a hung child (observed twice on long transcodes) fails the tier
// instead of stalling the queue forever.
export const execFile = (file: string, args: string[]) =>
  promisify(execFileCb)(file, args, { timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });

export async function withWorkDir<T>(assetId: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = `/tmp/${assetId}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function runTier(
  pipeline: Pipeline,
  inputPath: string,
  tier: TierSpec,
  workDir: string,
): Promise<{ outPath: string; mimeType: string; ext: string }> {
  return pipeline(inputPath, tier, workDir);
}
