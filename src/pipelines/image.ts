import sharp from "sharp";
import type { Pipeline } from "../types.js";

export const image: Pipeline = async (inputPath, tier, workDir) => {
  const width = Number(tier.params.width ?? 960);
  const quality = Number(tier.params.quality ?? 80);
  const outPath = `${workDir}/${tier.label}.webp`;
  await sharp(inputPath)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality })
    .toFile(outPath);
  return { outPath, mimeType: "image/webp", ext: "webp" };
};
