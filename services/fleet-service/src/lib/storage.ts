// Document files never pass through the database (Database.md §7.2): clients upload straight to
// object storage with a short-lived URL, and reviewers read them the same way.
//   s3    — pre-signed S3 URLs (AWS, or MinIO via S3_ENDPOINT)
//   local — files in a directory, served by this service at /api/fleet/files/:ticket
//           (development only; config refuses it in production)

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Signer } from "./crypto.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];

export const UPLOAD_URL_SECONDS = 5 * 60;
export const VIEW_URL_SECONDS = 5 * 60;

export interface PresignedPut {
  url: string;
  /** headers the client must send with the PUT */
  headers: Record<string, string>;
}

export interface ObjectStore {
  presignPut(key: string, contentType: UploadType, sizeBytes: number): Promise<PresignedPut>;
  presignGet(key: string): Promise<string>;
  /** Size and (where cheap) SHA-256 of a stored object; null when it isn't there. */
  stat(key: string): Promise<{ size: number; sha256?: Buffer } | null>;
}

export function s3Store(opts: { bucket: string; region: string; endpoint?: string; forcePathStyle: boolean }): ObjectStore {
  const s3 = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle });
  return {
    async presignPut(key, contentType, sizeBytes) {
      const cmd = new PutObjectCommand({ Bucket: opts.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes });
      return { url: await getSignedUrl(s3, cmd, { expiresIn: UPLOAD_URL_SECONDS }), headers: { "content-type": contentType } };
    },
    presignGet: (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), { expiresIn: VIEW_URL_SECONDS }),
    async stat(key) {
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: opts.bucket, Key: key }));
        return { size: head.ContentLength ?? 0 };
      } catch (err) {
        if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

/** What a local-storage URL ticket allows: one PUT of a known type and size, or one GET. */
export interface FileTicket {
  key: string;
  op: "put" | "get";
  contentType?: UploadType;
  sizeBytes?: number;
}

export interface LocalStore extends ObjectStore {
  readonly local: true;
  read(key: string): Promise<Buffer>;
  write(key: string, body: Buffer): Promise<void>;
  contentTypeOf(key: string): string;
}

export function localStore(dir: string, sign: Signer, publicPath = "/api/fleet/files"): LocalStore {
  const root = resolve(dir);
  const pathOf = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(root + "/")) throw new Error("invalid object key");
    return p;
  };
  return {
    local: true,
    async presignPut(key, contentType, sizeBytes) {
      const ticket = sign.sign<FileTicket>({ key, op: "put", contentType, sizeBytes }, UPLOAD_URL_SECONDS);
      return { url: `${publicPath}/${ticket}`, headers: { "content-type": contentType } };
    },
    async presignGet(key) {
      return `${publicPath}/${sign.sign<FileTicket>({ key, op: "get" }, VIEW_URL_SECONDS)}`;
    },
    async stat(key) {
      try {
        const body = await readFile(pathOf(key));
        return { size: body.length, sha256: createHash("sha256").update(body).digest() };
      } catch {
        return null;
      }
    },
    read: (key) => readFile(pathOf(key)),
    async write(key, body) {
      const p = pathOf(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    contentTypeOf(key) {
      // keys end in the upload's extension (see objectKey in fleet/service.ts)
      const ext = key.slice(key.lastIndexOf(".") + 1);
      return (Object.keys(EXTENSION) as UploadType[]).find((t) => EXTENSION[t] === ext) ?? "application/octet-stream";
    },
  };
}

export const EXTENSION: Record<UploadType, string> = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
