"use client";

import {
  FinalizeRecordingSchema,
  MultipartRecordPacker,
  PublicWrappingMaterialSchema,
  RECORDING_CODEC,
  RECORDING_PROTOCOL_VERSION,
  RECORDING_SUITE_ID,
  authenticateManifest,
  createMasterKey,
  createNoncePrefix,
  deriveRecordingKeyMaterial,
  encodeBase64Url,
  encryptRecordingChunk,
  importDerivedRecordingKeys,
  wrapMasterKey,
  type ManifestChunk,
  type ManifestPart,
  type PackedMultipartPart,
  type PublicWrappingMaterial,
  type UploadedPartReceipt,
} from "@slopproof/media";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  postReplacementAttempt,
  postTechnicalAbort,
  type TechnicalAbortReason,
} from "./technical-recovery";
import {
  PostUploadStatusCard,
  type PostUploadStatus,
} from "./post-upload-status";
import { waitForPostUploadStatus } from "../../../lib/attempt-status";
import {
  captureProofQuestionIntervalV1,
  finalizeProofQuestionIntervalsV1,
  type ProofQuestionIntervalDraft,
} from "../../../lib/proof-question-timing";

type ProofQuestion = {
  id: string;
  order: number;
  prompt: string;
  reference: {
    id: string;
    file: string;
    oldStart: number;
    newStart: number;
    hunkHeader: string;
    changedLines: number;
    evidence: string;
  };
  maximumAnswerSeconds: number;
};

type ProofContext = {
  attemptId: string;
  revisionId: string;
  headSha: string;
  csrfToken: string;
  material: PublicWrappingMaterial;
  questions: ProofQuestion[];
  maximumDurationMs: number;
  maximumUploadBytes: number;
  retentionHours: number;
};

type Phase =
  | "opening"
  | "ready"
  | "recording"
  | "uploading"
  | "processing"
  | "reviewing"
  | "error";

export function MobileProof() {
  const search = useSearchParams();
  const [phase, setPhase] = useState<Phase>("opening");
  const [context, setContext] = useState<ProofContext>();
  const [error, setError] = useState<string>();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [progress, setProgress] = useState("Waiting for recording");
  const [postUploadStatus, setPostUploadStatus] =
    useState<PostUploadStatus>("processing");
  const [canRecover, setCanRecover] = useState(false);
  const [exchangePending, setExchangePending] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const abortedRef = useRef(false);
  const startedRef = useRef(false);
  const abortReasonRef = useRef<TechnicalAbortReason>(
    "encryption_or_upload_failed",
  );
  const abortIdempotencyRef = useRef<string | undefined>(undefined);
  const retryIdempotencyRef = useRef<string | undefined>(undefined);
  const exchangeStartedRef = useRef(false);
  const recordingStartedAtRef = useRef<number | undefined>(undefined);
  const activeQuestionStartMsRef = useRef(0);
  const questionIntervalsRef = useRef<ProofQuestionIntervalDraft[]>([]);

  async function openHandoff(): Promise<void> {
    if (exchangeStartedRef.current) return;
    const token = search.get("token");
    if (!token) {
      fail("This handoff link is missing or has already been removed.");
      return;
    }
    setExchangePending(true);
    setError(undefined);

    try {
      mediaRef.current = await requestProofMedia();
    } catch (caught) {
      setExchangePending(false);
      setError(mediaPreflightError(caught));
      return;
    }

    exchangeStartedRef.current = true;

    let exchanged: {
      attemptId: string;
      headSha: string;
      csrfToken: string;
      wrappingMaterial: unknown;
    };
    try {
      exchanged = await jsonRequest("/api/handoff/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      exchangeStartedRef.current = false;
      setExchangePending(false);
      stopProofMedia(mediaRef.current);
      mediaRef.current = undefined;
      fail("This one-time handoff is invalid, expired, or already used.");
      return;
    }

    try {
      const material = PublicWrappingMaterialSchema.parse(
        exchanged.wrappingMaterial,
      );
      const plan = await jsonRequest<{
        revisionId: string;
        questions: ProofQuestion[];
        maximumDurationMs: number;
        maximumUploadBytes: number;
        retentionHours: number;
      }>(`/api/attempts/${exchanged.attemptId}/questions`);
      if (plan.questions.length === 0)
        throw new Error("The proof plan has no questions.");
      window.history.replaceState(null, "", "/m/handoff");
      setContext({
        attemptId: exchanged.attemptId,
        revisionId: plan.revisionId,
        headSha: exchanged.headSha,
        csrfToken: exchanged.csrfToken,
        material,
        questions: plan.questions,
        maximumDurationMs: plan.maximumDurationMs,
        maximumUploadBytes: plan.maximumUploadBytes,
        retentionHours: plan.retentionHours,
      });
      setExchangePending(false);
      setPhase("ready");
    } catch {
      setExchangePending(false);
      stopProofMedia(mediaRef.current);
      mediaRef.current = undefined;
      fail(
        "The handoff was accepted, but the proof questions could not be loaded. Return to the contributor check and create a fresh handoff.",
      );
    }
  }

  useEffect(() => {
    return () => mediaRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    const preview = previewRef.current;
    const stream = mediaRef.current;
    if (phase !== "ready" || !preview || !stream) return;
    preview.srcObject = stream;
    void preview.play().catch(() => {
      setError(
        "The camera is available, but its preview could not start. Check this browser's media settings before recording.",
      );
    });
  }, [phase]);

  async function beginRecording(): Promise<void> {
    if (!context || !mediaRef.current) return;
    try {
      abortedRef.current = false;
      startedRef.current = true;
      abortReasonRef.current = "encryption_or_upload_failed";
      abortIdempotencyRef.current = `technical-abort:${crypto.randomUUID()}`;
      retryIdempotencyRef.current = `technical-retry:${crypto.randomUUID()}`;
      setCanRecover(false);
      setQuestionIndex(0);
      recordingStartedAtRef.current = undefined;
      activeQuestionStartMsRef.current = 0;
      questionIntervalsRef.current = [];
      setProgress("Encrypting locally before upload");
      await jsonRequest(`/api/attempts/${context.attemptId}/start`, {
        method: "POST",
        headers: mutationHeaders(context.csrfToken),
      });
      const upload = await jsonRequest<{ uploadSessionId: string }>(
        `/api/attempts/${context.attemptId}/uploads`,
        {
          method: "POST",
          headers: {
            ...mutationHeaders(context.csrfToken),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            materialId: context.material.materialId,
            objectId: context.material.objectId,
            codec: RECORDING_CODEC,
          }),
        },
      );
      setPhase("recording");
      await recordEncryptAndUpload(context, upload.uploadSessionId);
      startedRef.current = false;
      setPostUploadStatus("processing");
      setPhase("processing");
      setProgress(
        "Your recording was uploaded successfully. SlopProof is checking your explanation now.",
      );
      let status;
      try {
        status = await waitForPostUploadStatus(context.attemptId);
      } catch {
        setProgress(
          "Your recording was uploaded successfully. SlopProof could not refresh its status yet, so check the pull request for the result before trying again.",
        );
        return;
      }
      if (status === "review_required" || status === "passed") {
        setPostUploadStatus(status);
        setPhase("reviewing");
        setProgress(
          status === "passed"
            ? "This revision has been approved."
            : "Processing is complete. Your proof is waiting for a maintainer decision.",
        );
      } else if (status === "technical_retry") {
        setCanRecover(true);
        fail(
          "Server validation failed safely. The encrypted evidence was removed; create a fresh attempt.",
        );
      } else if (status === "invalidated") {
        fail("A newer head SHA replaced this attempt. Open the current check.");
      } else if (status === "retry_required" || status === "expired") {
        setCanRecover(true);
        fail("This attempt needs a fresh proof before it can be reviewed.");
      } else {
        setProgress(
          "Your recording was uploaded successfully and is still being checked.",
        );
      }
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "The recording could not be completed. No domain failure was recorded.";
      if (startedRef.current) {
        try {
          const aborted = await requestTechnicalAbort(context);
          if (aborted.status === "already_progressed") {
            startedRef.current = false;
            setCanRecover(false);
            setPostUploadStatus("processing");
            setPhase("processing");
            setProgress(
              "Your recording was uploaded successfully and is still being checked.",
            );
            return;
          }
          if (aborted.status === "invalidated") {
            setCanRecover(false);
            fail(
              "A newer head SHA replaced this attempt. Open the current check.",
            );
            return;
          }
          setCanRecover(true);
        } catch {
          // The recovery button replays the same idempotent abort before retry.
          setCanRecover(true);
        }
      }
      fail(message);
    } finally {
      recorderRef.current = undefined;
      mediaRef.current?.getTracks().forEach((track) => track.stop());
    }
  }

  async function recordEncryptAndUpload(
    proof: ProofContext,
    uploadSessionId: string,
  ): Promise<void> {
    const masterKey = createMasterKey();
    const noncePrefix = createNoncePrefix();
    const binding = {
      attemptId: proof.attemptId,
      headSha: proof.headSha,
      objectId: proof.material.objectId,
    };
    let keys: Awaited<ReturnType<typeof importDerivedRecordingKeys>>;
    let wrappedKey: Awaited<ReturnType<typeof wrapMasterKey>>;
    try {
      const derived = await deriveRecordingKeyMaterial(masterKey, binding);
      try {
        keys = await importDerivedRecordingKeys(derived);
      } finally {
        derived.encryptionKeyBytes.fill(0);
        derived.manifestKeyBytes.fill(0);
      }
      wrappedKey = await wrapMasterKey(masterKey, proof.material, binding);
    } finally {
      masterKey.fill(0);
    }

    const packer = new MultipartRecordPacker();
    const chunks: ManifestChunk[] = [];
    const parts: ManifestPart[] = [];
    const uploadedParts: UploadedPartReceipt[] = [];
    let chunkIndex = 0;
    let plaintextBytes = 0;
    let objectBytes = 0;
    let queue = Promise.resolve();
    let pipelineError: unknown;
    const recorder = new MediaRecorder(mediaRef.current!, {
      mimeType: RECORDING_CODEC,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
    });
    recorderRef.current = recorder;
    const startedAt = performance.now();
    recordingStartedAtRef.current = startedAt;
    activeQuestionStartMsRef.current = 0;
    questionIntervalsRef.current = [];

    const processBlob = async (blob: Blob): Promise<void> => {
      if (blob.size === 0) return;
      const plaintext = new Uint8Array(await blob.arrayBuffer());
      try {
        const encrypted = await encryptRecordingChunk({
          plaintext,
          chunkIndex,
          noncePrefix,
          binding,
          encryptionKey: keys.encryptionKey,
        });
        const nextObjectBytes = objectBytes + encrypted.record.byteLength;
        if (nextObjectBytes > proof.maximumUploadBytes) {
          encrypted.record.fill(0);
          encrypted.sealed.fill(0);
          throw new Error("The encrypted recording reached its upload limit.");
        }
        objectBytes = nextObjectBytes;
        chunks.push(encrypted.manifest);
        plaintextBytes += plaintext.byteLength;
        const readyParts = await packer.push(encrypted.record);
        encrypted.record.fill(0);
        encrypted.sealed.fill(0);
        chunkIndex += 1;
        for (const part of readyParts) {
          uploadedParts.push(
            await uploadPart(proof.csrfToken, uploadSessionId, part),
          );
          parts.push(stripPartBytes(part));
          part.bytes.fill(0);
          setProgress(`Uploaded encrypted part ${String(part.partNumber)}`);
        }
      } finally {
        plaintext.fill(0);
      }
    };

    recorder.addEventListener("dataavailable", (event) => {
      queue = queue
        .then(() => processBlob(event.data))
        .catch((caught: unknown) => {
          pipelineError = caught;
          abortedRef.current = true;
          abortReasonRef.current = "encryption_or_upload_failed";
          if (recorder.state !== "inactive") recorder.stop();
        });
    });
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener(
        "error",
        () => {
          abortedRef.current = true;
          abortReasonRef.current = "recorder_error";
          reject(new Error("MediaRecorder reported a technical error."));
        },
        { once: true },
      );
    });
    const onVisibility = () => {
      if (document.hidden && recorder.state === "recording") {
        abortedRef.current = true;
        abortReasonRef.current = "visibility_lost";
        recorder.stop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    for (const track of mediaRef.current!.getTracks()) {
      track.addEventListener(
        "ended",
        () => {
          if (recorder.state === "recording") {
            abortedRef.current = true;
            abortReasonRef.current = "media_track_ended";
            recorder.stop();
          }
        },
        { once: true },
      );
    }
    const deadline = window.setTimeout(() => {
      if (recorder.state === "recording") {
        abortedRef.current = true;
        abortReasonRef.current = "duration_exceeded";
        recorder.stop();
      }
    }, proof.maximumDurationMs);
    recorder.start(1_000);
    await stopped;
    const finalDraftEndMs = questionIntervalsRef.current.at(-1)?.endMs ?? 0;
    const recordedDurationMs = Math.max(
      1,
      Math.round(performance.now() - startedAt),
      finalDraftEndMs,
    );
    window.clearTimeout(deadline);
    document.removeEventListener("visibilitychange", onVisibility);
    await queue;
    if (pipelineError) throw pipelineError;
    if (abortedRef.current) {
      throw new Error("Recording was interrupted; start a technical retry.");
    }
    if (questionIntervalsRef.current.length !== proof.questions.length) {
      throw new Error(
        "The recording did not capture the complete proof question order.",
      );
    }
    const questionIntervals = finalizeProofQuestionIntervalsV1({
      drafts: questionIntervalsRef.current,
      expectedQuestionIds: proof.questions.map((question) => question.id),
      recordedDurationMs,
    });
    setPhase("uploading");
    for (const part of await packer.finish()) {
      uploadedParts.push(
        await uploadPart(proof.csrfToken, uploadSessionId, part),
      );
      parts.push(stripPartBytes(part));
      part.bytes.fill(0);
    }
    const manifest = {
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      suiteId: RECORDING_SUITE_ID,
      ...binding,
      codec: RECORDING_CODEC,
      noncePrefixBase64url: encodeBase64Url(noncePrefix),
      wrapping: {
        materialId: wrappedKey.materialId,
        keyId: wrappedKey.keyId,
        algorithm: wrappedKey.algorithm,
        wrappedKeySha256: wrappedKey.wrappedKeySha256,
      },
      durationMs: recordedDurationMs,
      totalPlaintextBytes: plaintextBytes,
      totalObjectBytes: parts.reduce(
        (total, part) => total + part.byteLength,
        0,
      ),
      questionIntervals,
      chunks,
      parts,
    };
    const authenticated = await authenticateManifest(
      manifest,
      keys.manifestKey,
    );
    const finalization = FinalizeRecordingSchema.parse({
      ...authenticated,
      wrappedKey,
      uploadedParts,
    });
    await jsonRequest("/api/uploads/finalize", {
      method: "POST",
      headers: {
        ...mutationHeaders(proof.csrfToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ uploadSessionId, finalization }),
    });
    noncePrefix.fill(0);
  }

  function nextQuestion(): void {
    if (!context || phase !== "recording") return;
    const startedAt = recordingStartedAtRef.current;
    const question = context.questions[questionIndex];
    if (
      startedAt === undefined ||
      question === undefined ||
      questionIntervalsRef.current.length !== questionIndex
    ) {
      return;
    }
    const interval = captureProofQuestionIntervalV1({
      questionId: question.id,
      ordinal: questionIndex,
      recordingStartedAtMs: startedAt,
      questionStartedAtMs: activeQuestionStartMsRef.current,
      nowMs: performance.now(),
    });
    questionIntervalsRef.current.push(interval);
    if (questionIndex < context.questions.length - 1) {
      activeQuestionStartMsRef.current = interval.endMs;
      setQuestionIndex((current) => current + 1);
      return;
    }
    setPhase("uploading");
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function fail(message: string): void {
    setError(message);
    setPhase("error");
  }

  async function requestTechnicalAbort(proof: ProofContext): Promise<{
    status: "technical_retry" | "invalidated" | "already_progressed";
  }> {
    abortIdempotencyRef.current ??= `technical-abort:${crypto.randomUUID()}`;
    return postTechnicalAbort({
      attemptId: proof.attemptId,
      headSha: proof.headSha,
      csrfToken: proof.csrfToken,
      idempotencyKey: abortIdempotencyRef.current,
      reason: abortReasonRef.current,
    });
  }

  async function recoverTechnicalFailure(): Promise<void> {
    if (!context) return;
    setCanRecover(false);
    setProgress("Checking the accepted state and cleaning up the upload…");
    try {
      const aborted = await requestTechnicalAbort(context);
      if (aborted.status === "already_progressed") {
        startedRef.current = false;
        setPhase("processing");
        setProgress("Finalization was accepted and is still being processed.");
        return;
      }
      if (aborted.status === "invalidated") {
        window.location.assign(`/revisions/${context.revisionId}`);
        return;
      }
      retryIdempotencyRef.current ??= `technical-retry:${crypto.randomUUID()}`;
      const retry = await postReplacementAttempt({
        attemptId: context.attemptId,
        headSha: context.headSha,
        csrfToken: context.csrfToken,
        idempotencyKey: retryIdempotencyRef.current,
      });
      window.location.assign(retry.contributorUrl);
    } catch (caught) {
      setCanRecover(true);
      fail(
        caught instanceof Error
          ? caught.message
          : "The technical cleanup could not be confirmed. Try again.",
      );
    }
  }

  const question = context?.questions[questionIndex];

  return (
    <main className="mobile-shell">
      <p className="eyebrow">SlopProof · one take</p>
      {phase === "opening" ? (
        <section className="recording-card reviewing-card">
          <p className="eyebrow">One-time handoff</p>
          <h1>Open secure proof.</h1>
          <p>
            First, this device checks camera and microphone access. The one-time
            link is consumed only after that check succeeds.
          </p>
          {error ? (
            <p className="permission-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="button primary full-button"
            disabled={exchangePending}
            onClick={() => void openHandoff()}
            type="button"
          >
            {exchangePending
              ? "Checking camera and opening proof…"
              : "Check camera and open proof"}
          </button>
        </section>
      ) : null}
      {phase === "ready" ? (
        <>
          <h1>Camera and privacy check.</h1>
          <video
            className="camera-preview"
            muted
            playsInline
            ref={previewRef}
          />
          {error ? (
            <p className="permission-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mobile-facts">
            <p>
              <strong>{context?.questions.length}</strong> questions in one
              uninterrupted take
            </p>
            <p>
              <strong>Ciphertext only</strong> leaves this browser
            </p>
            <p>
              <strong>{context?.retentionHours} hours</strong> maximum evidence
              retention
            </p>
          </div>
          <button
            className="button primary full-button"
            onClick={() => void beginRecording()}
            type="button"
          >
            Start one-take proof
          </button>
        </>
      ) : null}
      {phase === "recording" && question ? (
        <section className="recording-card">
          <div className="recording-indicator">
            <span /> Recording · question {question.order}/
            {context?.questions.length}
          </div>
          <div className="proof-reference">
            <p className="eyebrow">Patch reference</p>
            <code>
              {question.reference.file}:{question.reference.newStart}
            </code>
            <p>{question.reference.hunkHeader}</p>
            <pre>{question.reference.evidence}</pre>
          </div>
          <h1>{question.prompt}</h1>
          <p>Speak naturally and refer to the concrete patch behavior.</p>
          <button
            className="button primary full-button"
            onClick={nextQuestion}
            type="button"
          >
            {questionIndex === (context?.questions.length ?? 1) - 1
              ? "Finish recording"
              : "Next question"}
          </button>
        </section>
      ) : null}
      {phase === "uploading" ? (
        <section className="recording-card">
          <p className="eyebrow">Encrypted upload</p>
          <h1>Finishing the protected evidence.</h1>
          <p>{progress}</p>
        </section>
      ) : null}
      {phase === "processing" ? (
        <PostUploadStatusCard status="processing" detail={progress} />
      ) : null}
      {phase === "reviewing" ? (
        <PostUploadStatusCard status={postUploadStatus} detail={progress} />
      ) : null}
      {phase === "error" ? (
        <section className="recording-card error-card">
          <p className="eyebrow">
            {context ? "Technical retry" : "Secure handoff"}
          </p>
          <h1>
            {context
              ? "Recording did not complete."
              : "Handoff could not be opened."}
          </h1>
          <p>{error}</p>
          {canRecover ? (
            <button
              className="button primary full-button"
              onClick={() => void recoverTechnicalFailure()}
              type="button"
            >
              Clean up and create a fresh attempt
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

async function uploadPart(
  csrfToken: string,
  uploadSessionId: string,
  part: PackedMultipartPart,
): Promise<UploadedPartReceipt> {
  const allocation = await jsonRequest<{
    uploadUrl: string;
    method: "PUT";
    headers: Record<string, string>;
  }>("/api/uploads/part-url", {
    method: "POST",
    headers: {
      ...mutationHeaders(csrfToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ uploadSessionId, part: stripPartBytes(part) }),
  });
  const response = await fetch(allocation.uploadUrl, {
    method: allocation.method,
    headers: allocation.headers,
    body: part.bytes.slice().buffer,
  });
  if (!response.ok)
    throw new Error("The object store rejected an encrypted part.");
  const etag = response.headers.get("etag");
  if (!etag)
    throw new Error("The object store did not expose an ETag receipt.");
  await jsonRequest("/api/uploads/part-complete", {
    method: "POST",
    headers: {
      ...mutationHeaders(csrfToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ uploadSessionId, part: stripPartBytes(part), etag }),
  });
  return { partNumber: part.partNumber, etag };
}

function stripPartBytes(part: PackedMultipartPart): ManifestPart {
  return {
    partNumber: part.partNumber,
    firstChunkIndex: part.firstChunkIndex,
    lastChunkIndex: part.lastChunkIndex,
    byteLength: part.byteLength,
    sha256: part.sha256,
  };
}

function mutationHeaders(csrfToken: string): Record<string, string> {
  return {
    "x-slopproof-csrf": csrfToken,
    "idempotency-key": `mobile:${crypto.randomUUID()}`,
  };
}

async function jsonRequest<T = unknown>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.error ?? `Request failed with ${String(response.status)}`,
    );
  }
  return payload;
}

async function requestProofMedia(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new Error("secure_context_required");
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("recording_unsupported");
  }
  if (!MediaRecorder.isTypeSupported(RECORDING_CODEC)) {
    throw new Error("codec_unsupported");
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

function mediaPreflightError(caught: unknown): string {
  if (caught instanceof DOMException) {
    if (caught.name === "NotAllowedError") {
      return "Camera or microphone access was denied. Allow both in this browser's site settings, then try this same link again. The one-time handoff has not been used.";
    }
    if (caught.name === "NotFoundError") {
      return "No usable camera or microphone was found. Connect both devices, then try this same link again. The one-time handoff has not been used.";
    }
    if (caught.name === "NotReadableError") {
      return "The camera or microphone is busy in another app. Close that app, then try this same link again. The one-time handoff has not been used.";
    }
  }
  if (caught instanceof Error) {
    if (caught.message === "secure_context_required") {
      return "A secure HTTPS context is required. Open the original SlopProof link in a current browser.";
    }
    if (caught.message === "recording_unsupported") {
      return "Camera recording is not supported by this browser. Try the current Safari or Chrome release.";
    }
    if (caught.message === "codec_unsupported") {
      return "This browser cannot record the required VP8/Opus format. Try the current Chrome release on this device.";
    }
  }
  return "Camera and microphone access could not be confirmed. Check this browser's site settings and try the same link again. The one-time handoff has not been used.";
}

function stopProofMedia(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
