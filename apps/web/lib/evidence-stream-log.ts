import { getWebLogger } from "./web-log";

export type WebEvidenceStreamStage = "capability" | "proxy";

export function logWebEvidenceStream(fields: {
  attemptId: string;
  stage: WebEvidenceStreamStage;
  bytesExpected?: number | null;
  contentTypePresent?: boolean;
  contentLengthPresent?: boolean;
  aborted?: boolean;
  httpStatus?: number;
  errorClass?: string;
}): void {
  getWebLogger().info(
    {
      attemptId: fields.attemptId,
      stage: fields.stage,
      ...(fields.bytesExpected === undefined
        ? {}
        : { bytesExpected: fields.bytesExpected }),
      ...(fields.contentTypePresent === undefined
        ? {}
        : { contentTypePresent: fields.contentTypePresent }),
      ...(fields.contentLengthPresent === undefined
        ? {}
        : { contentLengthPresent: fields.contentLengthPresent }),
      ...(fields.aborted === undefined ? {} : { aborted: fields.aborted }),
      ...(fields.httpStatus === undefined ? {} : { httpStatus: fields.httpStatus }),
      ...(fields.errorClass === undefined ? {} : { errorClass: fields.errorClass }),
    },
    "web.evidence.stream",
  );
}
