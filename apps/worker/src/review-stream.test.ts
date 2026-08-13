import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import type { S3EvidenceStore } from "@slopproof/storage";
import { describe, expect, it, vi } from "vitest";
import {
  handleReviewEvidenceRequest,
  type ReviewStreamFailure,
} from "./review-stream";

const ATTEMPT_ID = "53000000-0000-4000-8000-000000000001";

describe("private review stream failures", () => {
  it("reports only a fixed stage and error class, never the attempt identifier", async () => {
    const failure = vi.fn<(value: ReviewStreamFailure) => void>();
    const output = responseFixture();

    await expect(
      handleReviewEvidenceRequest(
        {
          method: "GET",
          url: `/internal/review/evidence/${ATTEMPT_ID}`,
          headers: { authorization: "Bearer invalid" },
        } as IncomingMessage,
        output.response,
        {
          database: {} as DatabaseConnection,
          storage: {} as S3EvidenceStore,
          privateKeyPath: "/run/secrets/wrapping-private.pem",
          capabilitySecret: "review-stream-test-secret-000000000000",
          onFailure: failure,
        },
      ),
    ).resolves.toBe(true);

    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith({
      stage: "capability",
      errorClass: "Error",
    });
    expect(JSON.stringify(failure.mock.calls)).not.toContain(ATTEMPT_ID);
    expect(output.status).toBe(401);
  });
});

function responseFixture(): Readonly<{
  response: ServerResponse;
  status: number | undefined;
}> {
  let status: number | undefined;
  const response = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      return this;
    },
    end: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ServerResponse;

  return {
    response,
    get status() {
      return status;
    },
  };
}
