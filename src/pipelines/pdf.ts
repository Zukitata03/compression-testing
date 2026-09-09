import { execFile } from "./util.js";
import type { Pipeline } from "../types.js";

export const pdf: Pipeline = async (inputPath, tier, workDir) => {
  const setting = String(tier.params.setting ?? "/ebook");
  const outPath = `${workDir}/${tier.label}.pdf`;
  await execFile("gs", [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    `-dPDFSETTINGS=${setting}`,
    "-dNOPAUSE", "-dBATCH", "-dQUIET",
    `-sOutputFile=${outPath}`,
    inputPath,
  ]);
  return { outPath, mimeType: "application/pdf", ext: "pdf" };
};
