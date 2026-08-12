import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { UploadPartCommand } from "@aws-sdk/client-s3";
import { z } from "zod";

export const storagePackage = "@slopproof/storage" as const;

const ConfigSchema = z
  .object({
    region: z.string().min(1),
    bucket: z.string().min(3),
    controlEndpoint: z.url(),
    publicEndpoint: z.url(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(8),
    forcePathStyle: z.boolean().default(true),
  })
  .strict();

const PresignUploadPartSchema = z
  .object({
    objectKey: z.string().min(1),
    uploadId: z.string().min(1),
    partNumber: z.number().int().positive(),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    expiresInSeconds: z.number().int().positive().optional(),
  })
  .strict();

export type EvidenceStoreConfig = z.input<typeof ConfigSchema>;

export type ListedPart = {
  partNumber: number;
  byteLength: number;
  etag: string;
};

export type CompletedPartReceipt = {
  partNumber: number;
  etag: string;
};

export class EvidenceStorageError extends Error {
  readonly code = "EVIDENCE_STORAGE_ERROR" as const;

  constructor(
    readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(`Evidence storage operation failed: ${operation}`, options);
    this.name = "EvidenceStorageError";
  }
}

export function createOpaqueEvidenceObjectKey(): string {
  return `evidence/v1/${randomUUID().replaceAll("-", "")}`;
}

export class S3EvidenceStore {
  readonly #bucket: string;
  readonly #control: S3Client;
  readonly #signer: S3Client;

  constructor(rawConfig: EvidenceStoreConfig) {
    const config = ConfigSchema.parse(rawConfig);
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    this.#bucket = config.bucket;
    this.#control = new S3Client({
      region: config.region,
      endpoint: config.controlEndpoint,
      forcePathStyle: config.forcePathStyle,
      credentials,
    });
    this.#signer = new S3Client({
      region: config.region,
      endpoint: config.publicEndpoint,
      forcePathStyle: config.forcePathStyle,
      credentials,
    });
  }

  async createMultipartUpload(objectKey: string): Promise<string> {
    try {
      const output = await this.#control.send(
        new CreateMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ContentType: "application/octet-stream",
          Metadata: { protocol: "SP-RC1", classification: "ciphertext" },
        }),
      );
      if (!output.UploadId)
        throw new Error("Storage did not return an upload ID");
      return output.UploadId;
    } catch (error) {
      throw new EvidenceStorageError("create_multipart", { cause: error });
    }
  }

  async presignUploadPart(input: {
    objectKey: string;
    uploadId: string;
    partNumber: number;
    byteLength: number;
    sha256: string;
    expiresInSeconds?: number;
  }): Promise<string> {
    try {
      const validated = PresignUploadPartSchema.parse(input);
      return await getSignedUrl(
        this.#signer,
        new UploadPartCommand({
          Bucket: this.#bucket,
          Key: validated.objectKey,
          UploadId: validated.uploadId,
          PartNumber: validated.partNumber,
          ContentLength: validated.byteLength,
          ChecksumSHA256: Buffer.from(validated.sha256, "hex").toString(
            "base64",
          ),
        }),
        { expiresIn: validated.expiresInSeconds ?? 5 * 60 },
      );
    } catch (error) {
      throw new EvidenceStorageError("presign_upload_part", { cause: error });
    }
  }

  async listParts(objectKey: string, uploadId: string): Promise<ListedPart[]> {
    try {
      const parts: ListedPart[] = [];
      let marker: string | undefined;
      do {
        const output = await this.#control.send(
          new ListPartsCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            UploadId: uploadId,
            ...(marker ? { PartNumberMarker: marker } : {}),
          }),
        );
        for (const part of output.Parts ?? []) {
          if (
            part.PartNumber === undefined ||
            part.Size === undefined ||
            part.ETag === undefined
          ) {
            throw new Error("Storage returned an incomplete part receipt");
          }
          parts.push({
            partNumber: part.PartNumber,
            byteLength: part.Size,
            etag: part.ETag,
          });
        }
        marker = output.IsTruncated
          ? output.NextPartNumberMarker?.toString()
          : undefined;
      } while (marker !== undefined);
      return parts.sort((left, right) => left.partNumber - right.partNumber);
    } catch (error) {
      throw new EvidenceStorageError("list_parts", { cause: error });
    }
  }

  async completeMultipartUpload(input: {
    objectKey: string;
    uploadId: string;
    parts: readonly CompletedPartReceipt[];
  }): Promise<void> {
    try {
      const parts: CompletedPart[] = input.parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
      }));
      await this.#control.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: input.objectKey,
          UploadId: input.uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      throw new EvidenceStorageError("complete_multipart", { cause: error });
    }
  }

  async abortMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.#control.send(
        new AbortMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      throw new EvidenceStorageError("abort_multipart", { cause: error });
    }
  }

  /** Provider-level fallback for multipart uploads orphaned from DB state. */
  async abortIncompleteMultipartUploadsOlderThan(
    cutoff: Date,
  ): Promise<number> {
    if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
      throw new EvidenceStorageError("abort_stale_multipart", {
        cause: new Error("Invalid multipart cutoff"),
      });
    }
    try {
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      let aborted = 0;
      do {
        const output = await this.#control.send(
          new ListMultipartUploadsCommand({
            Bucket: this.#bucket,
            Prefix: "evidence/v1/",
            MaxUploads: 1_000 - aborted,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
          }),
        );
        for (const upload of output.Uploads ?? []) {
          if (
            aborted >= 1_000 ||
            !upload.Key ||
            !upload.UploadId ||
            !upload.Initiated ||
            upload.Initiated > cutoff
          ) {
            continue;
          }
          await this.#control.send(
            new AbortMultipartUploadCommand({
              Bucket: this.#bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          aborted += 1;
        }
        if (!output.IsTruncated || aborted >= 1_000) break;
        keyMarker = output.NextKeyMarker;
        uploadIdMarker = output.NextUploadIdMarker;
      } while (keyMarker !== undefined);
      return aborted;
    } catch (error) {
      throw new EvidenceStorageError("abort_stale_multipart", { cause: error });
    }
  }

  async headObject(objectKey: string): Promise<{ byteLength: number }> {
    try {
      const output = await this.#control.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
      if (output.ContentLength === undefined) {
        throw new Error("Storage object has no content length");
      }
      return { byteLength: output.ContentLength };
    } catch (error) {
      throw new EvidenceStorageError("head_object", { cause: error });
    }
  }

  async getObjectStream(
    objectKey: string,
  ): Promise<ReadableStream<Uint8Array>> {
    try {
      const output = await this.#control.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
      if (!output.Body) throw new Error("Storage object has no body");
      return output.Body.transformToWebStream();
    } catch (error) {
      throw new EvidenceStorageError("get_object", { cause: error });
    }
  }

  async putCiphertextObject(
    objectKey: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    if (body.byteLength < 1 || body.byteLength > 2 * 1024 * 1024) {
      throw new EvidenceStorageError("put_ciphertext_size");
    }
    try {
      await this.#control.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          Body: body,
          ContentType: "application/octet-stream",
          Metadata: {
            classification: "ciphertext",
            ...metadata,
          },
        }),
      );
    } catch (error) {
      throw new EvidenceStorageError("put_ciphertext", { cause: error });
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.#control.send(
        new DeleteObjectCommand({ Bucket: this.#bucket, Key: objectKey }),
      );
    } catch (error) {
      throw new EvidenceStorageError("delete_object", { cause: error });
    }
  }

  destroy(): void {
    this.#control.destroy();
    this.#signer.destroy();
  }
}
