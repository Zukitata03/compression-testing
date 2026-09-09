import { PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { BUCKET_ORIGINALS, BUCKET_VARIANTS, s3 } from "./s3.js";
import type { PipelineId, Variant } from "./types.js";
import { image } from "./pipelines/image.js";
import { video } from "./pipelines/video.js";
import { audio } from "./pipelines/audio.js";
import { pdf } from "./pipelines/pdf.js";
import { office } from "./pipelines/office.js";
import { text } from "./pipelines/text.js";
import type { Pipeline } from "./types.js";

const PIPELINES: Record<PipelineId, Pipeline | null> = {
  image, video, audio, pdf, office, text,
  none: null,
};

export function pipelineFor(id: PipelineId): Pipeline | null {
  return PIPELINES[id];
}
export async function uploadFile(
  body: Readable | string | Buffer,
  key: string,
  bucket: string,
  contentType: string,
): Promise<void> {
  const Body = typeof body === "string" ? createReadStream(body) : body;
  await new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body, ContentType: contentType },
  }).done();
}

export async function getObjectStream(bucket: string, key: string, range?: string) {
  const res = await s3.send(new GetObjectCommand({
    Bucket: bucket, Key: key, ...(range ? { Range: range } : {}),
  }));
  return res;
}

export async function deletePrefix(bucket: string, prefix: string): Promise<void> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const objs = (listed.Contents ?? []).map((o) => ({ Key: o.Key }));
  if (objs.length > 0) {
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs } }));
  }
}

export function variantKey(assetId: string, label: string, ext: string): string {
  return `${assetId}/${label}.${ext}`;
}

export type { Variant };
