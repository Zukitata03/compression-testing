export type AssetKind = "image" | "video" | "audio" | "document" | "text" | "other";
export type AssetStatus = "uploaded" | "processing" | "ready" | "failed";

export interface Variant {
  label: string;
  sizeBytes: number;
  objectKey: string;
  mimeType: string;
  downloadable: boolean;
}

export interface Asset {
  id: string;
  originalName: string;
  kind: AssetKind;
  mimeType: string;
  originalBytes: number;
  status: AssetStatus;
  progress: { tier: number; total: number } | null;
  variants: Variant[];
  error?: string;
}

export interface Job {
  id: string;
  assetId: string;
  attempt: number;
  status: "queued" | "claimed" | "done" | "failed";
  claimedAt: Date | null;
}

export type PipelineId = "image" | "video" | "audio" | "pdf" | "office" | "text" | "none";

export interface TierSpec {
  label: string;
  params: Record<string, unknown>;
}

export interface FormatSpec {
  mimePrefixes: string[];
  kind: AssetKind;
  pipeline: PipelineId;
  tiers: TierSpec[];
}

export interface PipelineResult {
  outPath: string;
  mimeType: string;
  ext: string;
  // HLS: playlist plus numbered segment files share the workDir prefix.
  multiFile?: boolean;
  skip?: boolean;
}

export type Pipeline = (
  inputPath: string,
  tier: TierSpec,
  workDir: string,
) => Promise<PipelineResult>;
