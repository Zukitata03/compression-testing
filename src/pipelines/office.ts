import { rename } from "node:fs/promises";
import { execFile } from "./util.js";
import type { Pipeline } from "../types.js";
import { pdf } from "./pdf.js";

// LibreOffice headless converts to PDF first, then the PDF ladder applies.
// The converted PDF itself becomes the "original" tier (spec section 7).
export const office: Pipeline = async (inputPath, tier, workDir) => {
  const pdfPath = `${workDir}/converted.pdf`;
  await execFile("soffice", [
    "--headless", "--convert-to", "pdf", "--outdir", workDir, inputPath,
  ]);
  const base = inputPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  await rename(`${workDir}/${base}.pdf`, pdfPath);
  if (tier.label === "original") {
    return { outPath: pdfPath, mimeType: "application/pdf", ext: "pdf" };
  }
  return pdf(pdfPath, tier, workDir);
};
