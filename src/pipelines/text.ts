import { brotliCompress } from "node:zlib";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import * as zlib from "node:zlib";
import type { Pipeline } from "../types.js";

const brotli = promisify(brotliCompress);

// Lossless. Skips the tier when brotli saves less than 5% (spec section 7).
export const text: Pipeline = async (inputPath, tier, workDir) => {
  const quality = Number(tier.params.quality ?? 7);
  const buf = await readFile(inputPath);
  const compressed = await brotli(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality },
  });
  if (compressed.length > buf.length * 0.95) {
    return { outPath: "", mimeType: "", ext: "", skip: true };
  }
  const outPath = `${workDir}/${tier.label}.br`;
  await writeFile(outPath, compressed);
  return { outPath, mimeType: "application/octet-stream", ext: "br" };
};
