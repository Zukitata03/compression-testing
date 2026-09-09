import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const BUCKET_ORIGINALS = process.env.S3_BUCKET_ORIGINALS ?? "originals";
export const BUCKET_VARIANTS = process.env.S3_BUCKET_VARIANTS ?? "variants";

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "",
  },
  forcePathStyle: true,
});

export async function ensureBuckets(): Promise<void> {
  for (const bucket of [BUCKET_ORIGINALS, BUCKET_VARIANTS]) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}
