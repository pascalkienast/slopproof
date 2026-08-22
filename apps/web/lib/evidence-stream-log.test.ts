import { afterEach, describe, expect, it, vi } from "vitest";
import { logWebEvidenceStream } from "./evidence-stream-log";
import { setWebLoggerForTests } from "./web-log";

describe("web evidence stream logs", () => {
  afterEach(() => {
    setWebLoggerForTests(undefined);
  });

  it("writes attemptId and stage without cookies, tokens, or keys", () => {
    const info = vi.fn();
    setWebLoggerForTests({ info } as never);
    logWebEvidenceStream({
      attemptId: "10000000-0000-4000-8000-000000000001",
      stage: "proxy",
      httpStatus: 200,
      contentTypePresent: true,
      contentLengthPresent: false,
      bytesExpected: null,
      aborted: false,
      errorCode: "csrf_rejected",
    });
    expect(info).toHaveBeenCalledWith(
      {
        attemptId: "10000000-0000-4000-8000-000000000001",
        stage: "proxy",
        bytesExpected: null,
        contentTypePresent: true,
        contentLengthPresent: false,
        aborted: false,
        httpStatus: 200,
        errorCode: "csrf_rejected",
      },
      "web.evidence.stream",
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("cookie");
    expect(JSON.stringify(info.mock.calls)).not.toContain("Bearer");
    expect(JSON.stringify(info.mock.calls)).not.toContain("wrapped");
  });
});
