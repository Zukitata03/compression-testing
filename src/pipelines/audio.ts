import { execFile } from "./util.js";
import type { Pipeline } from "../types.js";

export const audio: Pipeline = async (inputPath, tier, workDir) => {
  const bitrate = String(tier.params.bitrate ?? "96k");
  const outPath = `${workDir}/${tier.label}.ogg`;
  await execFile("ffmpeg", [
    "-y", "-i", inputPath,
    "-c:a", "libopus", "-b:a", bitrate,
    "-threads", "2",
    outPath,
  ]);
  return { outPath, mimeType: "audio/ogg", ext: "ogg" };
};
