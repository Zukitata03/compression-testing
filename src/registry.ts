import type { FormatSpec } from "./types.js";

// The one file to edit for new formats. Every format rule lives here.
export const REGISTRY: FormatSpec[] = [
  {
    mimePrefixes: ["image/"],
    kind: "image",
    pipeline: "image",
    tiers: [
      { label: "1920w", params: { width: 1920, quality: 80 } },
      { label: "960w", params: { width: 960, quality: 80 } },
      { label: "320w", params: { width: 320, quality: 80 } },
    ],
  },
  {
    mimePrefixes: ["video/"],
    kind: "video",
    pipeline: "video",
    tiers: [
      { label: "1080p", params: { height: 1080 } },
      { label: "720p", params: { height: 720 } },
      { label: "480p", params: { height: 480 } },
      { label: "thumb", params: { seek: 1 } },
    ],
  },
  {
    mimePrefixes: ["audio/"],
    kind: "audio",
    pipeline: "audio",
    tiers: [{ label: "opus-96k", params: { bitrate: "96k" } }],
  },
  {
    mimePrefixes: ["application/pdf"],
    kind: "document",
    pipeline: "pdf",
    tiers: [
      { label: "screen", params: { setting: "/screen" } },
      { label: "ebook", params: { setting: "/ebook" } },
      { label: "print", params: { setting: "/printer" } },
    ],
  },
  {
    mimePrefixes: [
      "application/vnd.openxmlformats-officedocument",
      "application/vnd.ms-powerpoint",
      "application/vnd.ms-excel",
      "application/msword",
      "application/rtf",
      "application/vnd.oasis.opendocument",
    ],
    kind: "document",
    pipeline: "office",
    tiers: [
      { label: "screen", params: { setting: "/screen" } },
      { label: "ebook", params: { setting: "/ebook" } },
      { label: "print", params: { setting: "/printer" } },
    ],
  },
  {
    mimePrefixes: ["text/plain", "application/json", "text/csv", "application/xml", "text/xml", "text/markdown"],
    kind: "text",
    pipeline: "text",
    tiers: [{ label: "br", params: { quality: 7 } }],
  },
];

export function findSpec(mimeType: string): FormatSpec | undefined {
  return REGISTRY.find((s) => s.mimePrefixes.some((p) => mimeType.startsWith(p)));
}
