import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3EvidenceStore, createOpaqueEvidenceObjectKey } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S3 evidence adapter", () => {
  it("creates opaque keys without repository or actor data", () => {
    const key = createOpaqueEvidenceObjectKey();
    expect(key).toMatch(/^evidence\/v1\/[0-9a-f]{32}$/);
    expect(key).not.toContain("acme");
    expect(key).not.toContain("author");
  });

  it("constructs with separate control and public endpoints", () => {
    const store = new S3EvidenceStore({
      region: "us-east-1",
      bucket: "slopproof-evidence",
      controlEndpoint: "http://object-store:9000",
      publicEndpoint: "https://objects.slopproof.test",
      accessKeyId: "local",
      secretAccessKey: "local-secret",
      forcePathStyle: true,
    });
    expect(store).toBeInstanceOf(S3EvidenceStore);
    store.destroy();
  });

  it("binds a presigned part to its exact byte length and SHA-256", async () => {
    const store = new S3EvidenceStore({
      region: "us-east-1",
      bucket: "slopproof-evidence",
      controlEndpoint: "http://object-store:9000",
      publicEndpoint: "https://objects.slopproof.test",
      accessKeyId: "local",
      secretAccessKey: "local-secret",
      forcePathStyle: true,
    });
    const sha256 = "ab".repeat(32);

    const signed = new URL(
      await store.presignUploadPart({
        objectKey: "evidence/v1/test",
        uploadId: "upload-id",
        partNumber: 1,
        byteLength: 8 * 1024 * 1024,
        sha256,
        expiresInSeconds: 300,
      }),
    );

    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-length",
    );
    expect(signed.searchParams.get("x-amz-checksum-sha256")).toBe(
      Buffer.from(sha256, "hex").toString("base64"),
    );
    store.destroy();
  });

  it("aborts only provider multipart uploads older than the backstop cutoff", async () => {
    const aborted: { key?: string; uploadId?: string }[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      if (command instanceof ListMultipartUploadsCommand) {
        return {
          IsTruncated: false,
          Uploads: [
            {
              Key: "evidence/v1/stale",
              UploadId: "stale-upload",
              Initiated: new Date("2026-08-10T00:00:00.000Z"),
            },
            {
              Key: "evidence/v1/current",
              UploadId: "current-upload",
              Initiated: new Date("2026-08-12T00:00:00.000Z"),
            },
          ],
        };
      }
      if (command instanceof AbortMultipartUploadCommand) {
        if (!command.input.Key || !command.input.UploadId) {
          throw new Error("Abort command was missing its storage identity");
        }
        aborted.push({
          key: command.input.Key,
          uploadId: command.input.UploadId,
        });
        return {};
      }
      throw new Error("Unexpected S3 command");
    });
    const store = new S3EvidenceStore({
      region: "us-east-1",
      bucket: "slopproof-evidence",
      controlEndpoint: "http://object-store:9000",
      publicEndpoint: "https://objects.slopproof.test",
      accessKeyId: "local",
      secretAccessKey: "local-secret",
      forcePathStyle: true,
    });

    await expect(
      store.abortIncompleteMultipartUploadsOlderThan(
        new Date("2026-08-11T00:00:00.000Z"),
      ),
    ).resolves.toBe(1);
    expect(aborted).toEqual([
      { key: "evidence/v1/stale", uploadId: "stale-upload" },
    ]);
    store.destroy();
  });
});
