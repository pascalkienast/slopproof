import { describe, expect, it, vi } from "vitest";
import {
  HetznerMultimodalJudgeProvider,
  LocalFakeInlineMultimodalJudgeProvider,
  PROOF_JUDGE_SYSTEM_V2,
  manualReviewFallbackCandidateV1,
  validateMultimodalJudgeCandidateV1,
  type HetznerMultimodalJudgeDependencies,
  type MultimodalJudgeCandidateV1,
  type MultimodalJudgeProviderInputV1,
} from "./hetzner-multimodal";
import type { ProviderContextV1 } from "./contracts";
import { TransportFallbackMultimodalJudgeProvider } from "./transport-fallback";

const NOW = new Date("2026-08-13T01:00:00.000Z");
const DEADLINE = new Date(NOW.getTime() + 30_000);
const API_KEY = "judge-secret-never-log-this";
const QUESTION_ID = "10000000-0000-4000-8000-000000000001";
const CRITERION_A = "10000000-0000-4000-8000-000000000002";
const CRITERION_B = "10000000-0000-4000-8000-000000000003";

describe("HetznerMultimodalJudgeProvider", () => {
  it("sends only bounded review data and inline JPEGs to the primary model", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as unknown);
        expect(init).toMatchObject({
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        expect(new Headers(init?.headers).get("accept")).toBe(
          "text/event-stream",
        );
        return completionResponse(validCandidate());
      },
    );
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate(inputFixture(), contextFixture());

    expect(result.metadata).toMatchObject({
      provider: "hetzner-inference",
      model: "vision-model",
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
    });
    expect(JSON.stringify(result)).not.toContain(
      "private reasoning must never be persisted",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({
      model: "vision-model",
      store: false,
      stream: true,
      chat_template_kwargs: { thinking: false },
    });
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[0]).not.toHaveProperty("response_format");
    const imagePart = (
      bodies[0] as {
        messages: Array<{
          role: string;
          content: Array<{ image_url?: { url?: string; detail?: string } }>;
        }>;
      }
    ).messages
      .find((message) => message.role === "user")
      ?.content.find((part) => part.image_url !== undefined)?.image_url;
    expect(imagePart).toMatchObject({
      url: expect.stringMatching(/^data:image\/jpeg;base64,/u),
    });
    expect(imagePart).not.toHaveProperty("detail");
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).toContain("data:image/jpeg;base64,");
    expect(serialized).not.toContain("https://evidence");
    expect(serialized).not.toContain("attemptId");
    expect(serialized).not.toContain("revisionId");
    expect(serialized).not.toContain("contributor");
    expect(serialized).toContain("question-bound transcript");
    const system = (
      bodies[0] as {
        messages: Array<{ role: string; content: unknown }>;
      }
    ).messages.find((message) => message.role === "system")?.content;
    expect(system).toBe(PROOF_JUDGE_SYSTEM_V2);
  });

  it("allows frames for help versus no-help and keeps the biometric ban", () => {
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("question-bound transcript");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("help versus no-help");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("second screen");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("notes");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("reading off a device");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain(
      "Never identify or characterize a person",
    );
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("gaze as identity");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("disability");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("authorship");
    expect(PROOF_JUDGE_SYSTEM_V2).toContain("Do not describe a face");
    expect(PROOF_JUDGE_SYSTEM_V2).not.toContain("AUTHORITATIVE");
    expect(PROOF_JUDGE_SYSTEM_V2).not.toMatch(/identify the speaker/i);
    expect(PROOF_JUDGE_SYSTEM_V2).toContain(
      "Recommend retry when every criterion is evaluable",
    );
    expect(PROOF_JUDGE_SYSTEM_V2).toContain(
      "Recommend review_required when any criterion is not_evaluable",
    );
  });

  it("uses the primary text model when no inline frame is available", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completionResponse(validCandidate()));
    const provider = providerWith(fetchImpl);
    await provider.evaluate(
      { ...inputFixture(), frames: [] },
      contextFixture(),
    );
    const body = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(body.model).toBe("text-model");
    expect(JSON.stringify(body)).not.toContain("data:image");
  });

  it("assembles fragmented SSE content before validating the candidate", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(fragmentedCompletionResponse(validCandidate()));

    const result = await providerWith(fetchImpl).evaluate(
      { ...inputFixture(), frames: [] },
      contextFixture(),
    );

    expect(result.candidate.recommendation).toBe("pass");
    expect(result.metadata.tokenUsage).toEqual({
      inputTokens: 25,
      outputTokens: 10,
    });
  });

  it("accepts the single fenced JSON object emitted by the live Ox stream", async () => {
    const fenced = [
      "```json",
      JSON.stringify({ result: validCandidate() }),
      "```",
    ].join("\n");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completionTextResponse(fenced));

    const result = await providerWith(fetchImpl).evaluate(
      { ...inputFixture(), frames: [] },
      contextFixture(),
    );

    expect(result.candidate.recommendation).toBe("pass");
    expect(result.metadata.outcome).toBe("generated");
  });

  it.each([400, 415, 422])(
    "after Hetzner hop-vision HTTP %s, evaluates from the transcript without frames",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(completionResponse(validCandidate()));
      const result = await providerWith(fetchImpl).evaluate(
        inputFixture(),
        contextFixture(),
      );

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe(
        "vision-model",
      );
      const textOnly = JSON.parse(
        String(fetchImpl.mock.calls[1]?.[1]?.body),
      ) as {
        model: string;
        messages: Array<{ content: unknown }>;
      };
      expect(textOnly.model).toBe("text-model");
      expect(JSON.stringify(textOnly)).not.toContain("data:image");
      expect(result.metadata).toMatchObject({
        model: "text-model",
        invocationCount: 2,
        outcome: "repaired",
      });
    },
  );

  it.each([400, 404, 415, 422])(
    "uses the OpenRouter vision model after HTTP %s capability rejection",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(completionResponse(validCandidate()));
      const result = await new HetznerMultimodalJudgeProvider(
        {
          provider: "openrouter",
          baseUrl: "https://openrouter.example.test/api/v1",
          apiKey: API_KEY,
          model: "text-model",
          visionModel: "vision-model",
        },
        {
          fetchImpl,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ).evaluate(inputFixture(), contextFixture());

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const first = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
        model: string;
        tools: unknown;
        response_format: { type: string };
      };
      expect(first.model).toBe("text-model");
      expect(first.tools).toEqual([]);
      expect(first.response_format.type).toBe("json_schema");
      expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).model).toBe(
        "vision-model",
      );
      expect(result.metadata).toMatchObject({
        model: "vision-model",
        invocationCount: 2,
        outcome: "repaired",
      });
    },
  );

  it("repairs malformed bounded model content exactly once without resending it", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completionTextResponse("private malformed output"))
      .mockResolvedValueOnce(completionResponse(validCandidate()));
    const result = await providerWith(fetchImpl).evaluate(
      { ...inputFixture(), frames: [] },
      contextFixture(),
    );

    expect(result.metadata.invocationCount).toBe(2);
    expect(result.metadata.outcome).toBe("repaired");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe(
      "text-model",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).model).toBe(
      "text-model",
    );
    const repairBody = String(fetchImpl.mock.calls[1]?.[1]?.body);
    expect(repairBody).toContain("invalidOutputHash");
    expect(repairBody).toContain("maximumAdditionalAttempts");
    expect(repairBody).not.toContain("private malformed output");
    expect(JSON.stringify(result)).not.toContain("private malformed output");
  });

  it("gives repair a content-free explanation of invalid not-evaluable bindings", async () => {
    const invalid = structuredClone(validCandidate());
    invalid.recommendation = "review_required";
    invalid.privateReason = "stored_criteria_not_fully_supported";
    invalid.questionEvaluations[0]!.criterionResults =
      invalid.questionEvaluations[0]!.criterionResults.map((criterion) => ({
        ...criterion,
        result: "not_evaluable" as const,
        supportedPatchAnchorIds: [],
        reason: "patch_evidence_supports_criterion" as const,
      }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completionResponse(invalid))
      .mockResolvedValueOnce(completionResponse(validCandidate()));

    const result = await providerWith(fetchImpl).evaluate(
      { ...inputFixture(), frames: [] },
      contextFixture(),
    );

    expect(result.metadata).toMatchObject({
      invocationCount: 2,
      outcome: "repaired",
    });
    const initialBody = String(fetchImpl.mock.calls[0]?.[1]?.body);
    const repairBody = String(fetchImpl.mock.calls[1]?.[1]?.body);
    expect(initialBody).toContain("Never attach an anchor to not_evaluable");
    expect(repairBody).toContain("not_evaluable_reason_mismatch");
    expect(repairBody).not.toContain(JSON.stringify(invalid));
  });

  it("reports both failed semantic invocations with safe validation diagnostics", async () => {
    const invalid = structuredClone(validCandidate());
    invalid.recommendation = "review_required";
    invalid.privateReason = "stored_criteria_not_fully_supported";
    invalid.questionEvaluations[0]!.criterionResults =
      invalid.questionEvaluations[0]!.criterionResults.map((criterion) => ({
        ...criterion,
        result: "not_evaluable" as const,
        supportedPatchAnchorIds: ["a0"],
        reason: "patch_evidence_supports_criterion" as const,
      }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => completionResponse(invalid));

    await expect(
      providerWith(fetchImpl).evaluate(
        { ...inputFixture(), frames: [] },
        contextFixture(),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
      disposition: "review",
      telemetry: {
        lastFailureKind: "invalid_output",
        transportAttemptCount: 2,
      },
      validationCode: "binding_invalid",
      validationIssueCodes: expect.arrayContaining([
        "not_evaluable_with_anchor",
        "not_evaluable_reason_mismatch",
      ]),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "unknown question",
      mutate: (candidate: MultimodalJudgeCandidateV1) => ({
        ...candidate,
        questionEvaluations: [
          {
            ...candidate.questionEvaluations[0]!,
            questionId: "20000000-0000-4000-8000-000000000001",
          },
        ],
      }),
    },
    {
      name: "unknown criterion",
      mutate: (candidate: MultimodalJudgeCandidateV1) => ({
        ...candidate,
        questionEvaluations: [
          {
            ...candidate.questionEvaluations[0]!,
            criterionResults: [
              {
                ...candidate.questionEvaluations[0]!.criterionResults[0]!,
                criterionId: "20000000-0000-4000-8000-000000000002",
              },
              candidate.questionEvaluations[0]!.criterionResults[1]!,
            ],
          },
        ],
      }),
    },
    {
      name: "unknown anchor",
      mutate: (candidate: MultimodalJudgeCandidateV1) => ({
        ...candidate,
        questionEvaluations: [
          {
            ...candidate.questionEvaluations[0]!,
            criterionResults: [
              {
                ...candidate.questionEvaluations[0]!.criterionResults[0]!,
                supportedPatchAnchorIds: ["a99"],
              },
              candidate.questionEvaluations[0]!.criterionResults[1]!,
            ],
          },
        ],
      }),
    },
    {
      name: "new criterion",
      mutate: (candidate: MultimodalJudgeCandidateV1) => ({
        ...candidate,
        questionEvaluations: [
          {
            ...candidate.questionEvaluations[0]!,
            criterionResults: [
              ...candidate.questionEvaluations[0]!.criterionResults,
              {
                criterionId: "20000000-0000-4000-8000-000000000003",
                result: "met" as const,
                supportedPatchAnchorIds: ["a0"],
                reason: "patch_evidence_supports_criterion" as const,
              },
            ],
          },
        ],
      }),
    },
  ])("rejects $name additions or substitutions", ({ mutate }) => {
    expect(() =>
      validateMultimodalJudgeCandidateV1(
        mutate(validCandidate()),
        inputFixture(),
      ),
    ).toThrow("exact server contract");
  });

  it.each([
    "The contributor's face appears uncertain.",
    "The room background suggests assistance.",
    "The accent makes the answer less reliable.",
    "The software usage suggests copied work.",
    "This appears AI-generated by ChatGPT.",
    "The speaker is Pascal Kienast and appears 30 years old.",
    "Pascal Kienast appears trustworthy.",
    "The contributor appears female and her nationality sounds German.",
    "The recording suggests the speaker uses Cursor IDE.",
    "Der Blickkontakt wirkt unsicher.",
    "Der Akzent macht die Antwort weniger verlässlich.",
    "Der Sprecher heißt Pascal und seine Stimme klingt etwa 30 Jahre alt.",
    "Pascal Kienast ist ungefähr dreißig.",
    "Die Person wirkt weiblich; das Geschlecht ist aus der Stimme erkennbar.",
    "Die Nutzung von VS Code deutet auf fremde Hilfe hin.",
    "Die Werkzeugnutzung wirkt verdächtig.",
  ])("rejects prohibited person or tooling analysis: %s", (reason) => {
    const candidate = structuredClone(validCandidate()) as unknown as {
      questionEvaluations: Array<{
        criterionResults: Array<{ reason: string }>;
      }>;
    };
    candidate.questionEvaluations[0]!.criterionResults[0]!.reason = reason;
    expect(() =>
      validateMultimodalJudgeCandidateV1(candidate, inputFixture()),
    ).toThrow("exact server contract");
  });

  it("requires every exact criterion once and conservatively downgrades an incoherent pass", () => {
    const missing = validCandidate();
    missing.questionEvaluations[0]!.criterionResults.pop();
    expect(() =>
      validateMultimodalJudgeCandidateV1(missing, inputFixture()),
    ).toThrow();

    const unsafePass = manualReviewFallbackCandidateV1(inputFixture());
    expect(
      validateMultimodalJudgeCandidateV1(
        { ...unsafePass, recommendation: "pass" },
        inputFixture(),
      ),
    ).toMatchObject({
      recommendation: "review_required",
      privateReason: "stored_criteria_not_fully_supported",
      warnings: expect.arrayContaining(["incoherent_pass_normalized_downward"]),
    });
  });

  it("requires anchor evidence for negative findings and forbids pass with unresolved evidence", () => {
    const unsupported = validCandidate();
    unsupported.recommendation = "review_required";
    unsupported.questionEvaluations[0]!.criterionResults[0] = {
      ...unsupported.questionEvaluations[0]!.criterionResults[0]!,
      result: "not_met",
      supportedPatchAnchorIds: [],
      reason: "patch_evidence_conflicts_with_criterion",
    };
    expect(() =>
      validateMultimodalJudgeCandidateV1(unsupported, inputFixture()),
    ).toThrow();

    const unresolved = validCandidate();
    unresolved.questionEvaluations[0]!.contradictions = [
      "transcript_conflicts_with_patch_evidence",
    ];
    unresolved.questionEvaluations[0]!.uncertainty = [
      "transcript_evidence_incomplete",
    ];
    expect(
      validateMultimodalJudgeCandidateV1(unresolved, inputFixture()),
    ).toMatchObject({
      recommendation: "review_required",
      privateReason: "stored_criteria_not_fully_supported",
      warnings: expect.arrayContaining(["incoherent_pass_normalized_downward"]),
    });
  });

  it("normalizes an incoherent pass over bounded negative findings to retry", async () => {
    const incoherent = validCandidate();
    incoherent.questionEvaluations[0]!.criterionResults[0] = {
      ...incoherent.questionEvaluations[0]!.criterionResults[0]!,
      result: "not_met",
      reason: "patch_evidence_conflicts_with_criterion",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completionResponse(incoherent));

    const result = await providerWith(fetchImpl).evaluate(
      inputFixture(),
      contextFixture(),
    );

    expect(result.candidate).toMatchObject({
      recommendation: "retry",
      privateReason: "stored_criteria_not_fully_supported",
      warnings: expect.arrayContaining(["incoherent_pass_normalized_downward"]),
    });
    expect(result.metadata).toMatchObject({
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts the exact live MiMo contradiction as manual review without a repair loop", async () => {
    const incoherent = validCandidate();
    incoherent.questionEvaluations[0]!.criterionResults[0] = {
      ...incoherent.questionEvaluations[0]!.criterionResults[0]!,
      result: "not_evaluable",
      supportedPatchAnchorIds: [],
      reason: "question_evidence_insufficient",
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completionResponse(incoherent));

    const result = await providerWith(fetchImpl).evaluate(
      inputFixture(),
      contextFixture(),
    );

    expect(result.candidate).toMatchObject({
      recommendation: "review_required",
      privateReason: "stored_criteria_not_fully_supported",
      warnings: expect.arrayContaining(["incoherent_pass_normalized_downward"]),
    });
    expect(result.metadata).toMatchObject({
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "402", first: () => new Response(null, { status: 402 }) },
    { name: "408", first: () => new Response(null, { status: 408 }) },
    { name: "429", first: () => new Response(null, { status: 429 }) },
    { name: "503", first: () => new Response(null, { status: 503 }) },
    {
      name: "network",
      first: () => Promise.reject(new TypeError("private network detail")),
    },
  ])("retries only bounded $name transport failures", async ({ first }) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(first as typeof fetch)
      .mockResolvedValueOnce(completionResponse(validCandidate()));
    const sleep = vi.fn(async () => undefined);
    const result = await providerWith(fetchImpl, { sleep }).evaluate(
      inputFixture(),
      contextFixture(),
    );
    expect(result.candidate.recommendation).toBe("pass");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe(
      "vision-model",
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)).model).toBe(
      "vision-model",
    );
  });

  it.each([402, 404, 408])(
    "retries transient HTTP %s on the text model when no frame is available",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(completionResponse(validCandidate()));
      const sleep = vi.fn(async () => undefined);
      const result = await providerWith(fetchImpl, { sleep }).evaluate(
        { ...inputFixture(), frames: [] },
        contextFixture(),
      );
      expect(result.candidate.recommendation).toBe("pass");
      expect(result.metadata.model).toBe("text-model");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 401, 403, 415, 422])(
    "does not retry terminal HTTP %s without a multimodal capability fallback",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`private-${API_KEY}-${status}`, { status }),
        );
      let failure: unknown;
      try {
        await providerWith(fetchImpl).evaluate(
          { ...inputFixture(), frames: [] },
          contextFixture(),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        disposition: "terminal",
      });
      expect(String(failure)).not.toContain(API_KEY);
      expect(String(failure)).not.toContain("private-");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403])(
    "keeps HTTP %s terminal even when frames would allow a vision hop",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`private-${API_KEY}-${status}`, { status }),
        );
      let failure: unknown;
      try {
        await providerWith(fetchImpl).evaluate(
          inputFixture(),
          contextFixture(),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        disposition: "terminal",
      });
      expect(String(failure)).not.toContain(API_KEY);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([402, 404, 408])(
    "reports exhausted HTTP %s as retryable so the transport hop can run",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`private-body-${status}-${API_KEY}`, { status }),
        );
      const sleep = vi.fn(async () => undefined);
      let failure: unknown;
      try {
        await providerWith(fetchImpl, { sleep }).evaluate(
          { ...inputFixture(), frames: [] },
          contextFixture(),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        disposition: "retryable",
        telemetry: {
          lastFailureKind: "upstream_unavailable",
          httpStatusClass: "4xx",
          transportAttemptCount: 3,
          httpStatus: status,
        },
      });
      expect(String(failure)).not.toContain(API_KEY);
      expect(String(failure)).not.toContain("private-body");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    },
  );

  it.each([401, 403])(
    "keeps Hetzner hop-vision HTTP %s terminal without a text retry",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));
      await expect(
        providerWith(fetchImpl).evaluate(inputFixture(), contextFixture()),
      ).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        disposition: "terminal",
        telemetry: {
          httpStatus: status,
          lastFailureKind: "request_rejected",
        },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).model).toBe(
        "vision-model",
      );
    },
  );

  it("skips a no-op same-model vision hop and fails closed on HTTP 400", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    let failure: unknown;
    try {
      await new HetznerMultimodalJudgeProvider(
        {
          provider: "openrouter",
          baseUrl: "https://openrouter.example.test/api/v1",
          apiKey: API_KEY,
          model: "xiaomi/mimo-v2.5",
          visionModel: "xiaomi/mimo-v2.5",
        },
        {
          fetchImpl,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ).evaluate(inputFixture(), contextFixture());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      disposition: "terminal",
      telemetry: { httpStatus: 400, lastFailureKind: "request_rejected" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([402, 404, 408])(
    "retries HTTP %s then hops to the Hetzner judge fallback",
    async (status) => {
      const primaryFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`private-body-${status}-${API_KEY}`, { status }),
        );
      const fallbackFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(completionResponse(validCandidate()));
      const provider = new TransportFallbackMultimodalJudgeProvider(
        new HetznerMultimodalJudgeProvider(
          {
            provider: "openrouter",
            baseUrl: "https://openrouter.example.test/api/v1",
            apiKey: API_KEY,
            model: "xiaomi/mimo-v2.5",
            visionModel: "xiaomi/mimo-v2.5",
          },
          {
            fetchImpl: primaryFetch,
            policy: {
              maxAttempts: 3,
              streamIdleTimeoutMs: 100,
              now: () => NOW.getTime(),
              random: () => 0,
              sleep: async () => undefined,
            },
          },
        ),
        new HetznerMultimodalJudgeProvider(
          {
            provider: "hetzner-inference",
            baseUrl: "https://inference.example.test/api/v1",
            apiKey: API_KEY,
            model: "hetzner-judge",
            visionModel: "hetzner-vision",
          },
          {
            fetchImpl: fallbackFetch,
            policy: {
              maxAttempts: 3,
              streamIdleTimeoutMs: 100,
              now: () => NOW.getTime(),
              random: () => 0,
              sleep: async () => undefined,
            },
          },
        ),
      );

      const result = await provider.evaluate(
        { ...inputFixture(), frames: [] },
        contextFixture(),
      );

      expect(primaryFetch).toHaveBeenCalledTimes(3);
      expect(fallbackFetch).toHaveBeenCalledTimes(1);
      expect(result.metadata).toMatchObject({
        provider: "hetzner-inference",
        model: "hetzner-judge",
        outcome: "generated",
      });
      expect(JSON.stringify(result)).not.toContain(API_KEY);
      expect(JSON.stringify(result)).not.toContain("private-body");
    },
  );

  it("after the transport hop, a one-frame Hetzner vision request succeeds", async () => {
    const primaryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 408 }));
    const fallbackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(completionResponse(validCandidate()));
    const provider = new TransportFallbackMultimodalJudgeProvider(
      new HetznerMultimodalJudgeProvider(
        {
          provider: "openrouter",
          baseUrl: "https://openrouter.example.test/api/v1",
          apiKey: API_KEY,
          model: "xiaomi/mimo-v2.5",
          visionModel: "xiaomi/mimo-v2.5",
        },
        {
          fetchImpl: primaryFetch,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ),
      new HetznerMultimodalJudgeProvider(
        {
          provider: "hetzner-inference",
          baseUrl: "https://inference.example.test/api/v1",
          apiKey: API_KEY,
          model: "hetzner-judge",
          visionModel: "hetzner-vision",
        },
        {
          fetchImpl: fallbackFetch,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ),
    );

    const result = await provider.evaluate(inputFixture(), contextFixture());

    expect(primaryFetch).toHaveBeenCalledTimes(3);
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
    const hopBody = JSON.parse(String(fallbackFetch.mock.calls[0]?.[1]?.body));
    expect(hopBody.model).toBe("hetzner-vision");
    expect(hopBody).toMatchObject({
      chat_template_kwargs: { thinking: false },
    });
    expect(hopBody).not.toHaveProperty("tools");
    expect(hopBody).not.toHaveProperty("response_format");
    expect(JSON.stringify(hopBody)).toContain("data:image/jpeg;base64,");
    expect(JSON.stringify(hopBody)).not.toContain('"detail"');
    expect(result.metadata).toMatchObject({
      provider: "hetzner-inference",
      model: "hetzner-vision",
      invocationCount: 1,
      outcome: "generated",
    });
  });

  it("after the transport hop, vision HTTP 400 then text-only success still evaluates", async () => {
    const primaryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 402 }));
    const fallbackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(completionResponse(validCandidate()));
    const provider = new TransportFallbackMultimodalJudgeProvider(
      new HetznerMultimodalJudgeProvider(
        {
          provider: "openrouter",
          baseUrl: "https://openrouter.example.test/api/v1",
          apiKey: API_KEY,
          model: "xiaomi/mimo-v2.5",
          visionModel: "xiaomi/mimo-v2.5",
        },
        {
          fetchImpl: primaryFetch,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ),
      new HetznerMultimodalJudgeProvider(
        {
          provider: "hetzner-inference",
          baseUrl: "https://inference.example.test/api/v1",
          apiKey: API_KEY,
          model: "hetzner-judge",
          visionModel: "hetzner-vision",
        },
        {
          fetchImpl: fallbackFetch,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ),
    );

    const result = await provider.evaluate(inputFixture(), contextFixture());

    expect(fallbackFetch).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(fallbackFetch.mock.calls[0]?.[1]?.body)).model,
    ).toBe("hetzner-vision");
    expect(
      JSON.parse(String(fallbackFetch.mock.calls[1]?.[1]?.body)).model,
    ).toBe("hetzner-judge");
    expect(
      JSON.stringify(fallbackFetch.mock.calls[1]?.[1]?.body),
    ).not.toContain("data:image");
    expect(result.metadata).toMatchObject({
      provider: "hetzner-inference",
      model: "hetzner-judge",
      invocationCount: 2,
      outcome: "repaired",
    });
  });

  it("keeps hopUsed=transport_fallback diagnostics when hop vision and text both return 400", async () => {
    const primaryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const fallbackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    const provider = new TransportFallbackMultimodalJudgeProvider(
      new HetznerMultimodalJudgeProvider(
        {
          provider: "openrouter",
          baseUrl: "https://openrouter.example.test/api/v1",
          apiKey: API_KEY,
          model: "xiaomi/mimo-v2.5",
          visionModel: "xiaomi/mimo-v2.5",
        },
        {
          fetchImpl: primaryFetch,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ),
      new HetznerMultimodalJudgeProvider(
        {
          provider: "hetzner-inference",
          baseUrl: "https://inference.example.test/api/v1",
          apiKey: API_KEY,
          model: "hetzner-judge",
          visionModel: "hetzner-vision",
        },
        {
          fetchImpl: fallbackFetch,
          policy: {
            maxAttempts: 3,
            streamIdleTimeoutMs: 100,
            now: () => NOW.getTime(),
            random: () => 0,
            sleep: async () => undefined,
          },
        },
      ),
    );

    await expect(
      provider.evaluate(inputFixture(), contextFixture()),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      disposition: "terminal",
      hopUsed: "transport_fallback",
      telemetry: {
        httpStatus: 400,
        lastFailureKind: "request_rejected",
      },
    });
    expect(fallbackFetch).toHaveBeenCalledTimes(2);
  });

  it("reports an exhausted stream idle budget separately from the shared deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>(() => undefined),
    );
    const liveContext = {
      ...contextFixture(),
      deadlineAt: new Date(Date.now() + 1_000),
    };
    await expect(
      providerWith(fetchImpl, {
        maxAttempts: 1,
        streamIdleTimeoutMs: 5,
        now: Date.now,
      }).evaluate(inputFixture(), liveContext),
    ).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT",
      telemetry: {
        lastFailureKind: "timeout",
        transportAttemptCount: 1,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps DEADLINE_EXCEEDED for the actual provider-hop deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>(() => undefined),
    );
    const liveContext = {
      ...contextFixture(),
      deadlineAt: new Date(Date.now() + 20),
    };
    await expect(
      providerWith(fetchImpl, {
        maxAttempts: 1,
        streamIdleTimeoutMs: 100,
        now: Date.now,
      }).evaluate(inputFixture(), liveContext),
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      telemetry: {
        lastFailureKind: "deadline_exceeded",
        transportAttemptCount: 1,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses a deterministic not-evaluable manual-review fallback offline", async () => {
    const input = inputFixture();
    const fallback = manualReviewFallbackCandidateV1(input, [
      "frames_unavailable",
    ]);
    expect(fallback).toMatchObject({
      recommendation: "review_required",
      warnings: ["frames_unavailable"],
    });
    expect(
      fallback.questionEvaluations[0]?.criterionResults.every(
        (result) =>
          result.result === "not_evaluable" &&
          result.supportedPatchAnchorIds.length === 0,
      ),
    ).toBe(true);

    const local = await new LocalFakeInlineMultimodalJudgeProvider({
      now: () => NOW,
    }).evaluate(input, contextFixture());
    expect(local.candidate.recommendation).toBe("review_required");
    expect(local.metadata).toMatchObject({
      outcome: "fallback",
      degraded: true,
      invocationCount: 0,
    });
  });
});

function providerWith(
  fetchImpl: typeof fetch,
  policy: NonNullable<HetznerMultimodalJudgeDependencies["policy"]> = {},
) {
  return new HetznerMultimodalJudgeProvider(
    {
      baseUrl: "https://inference.example.test/api/v1",
      apiKey: API_KEY,
      model: "text-model",
      visionModel: "vision-model",
    },
    {
      fetchImpl,
      policy: {
        maxAttempts: 3,
        streamIdleTimeoutMs: 100,
        now: () => NOW.getTime(),
        random: () => 0,
        sleep: async () => undefined,
        ...policy,
      },
    },
  );
}

function contextFixture(): ProviderContextV1 {
  return {
    schemaVersion: "1",
    requestId: "10000000-0000-4000-8000-000000000010",
    attemptId: "10000000-0000-4000-8000-000000000011",
    deadlineAt: DEADLINE,
  };
}

function inputFixture(): MultimodalJudgeProviderInputV1 {
  return {
    schemaVersion: "1",
    inputVersion: "multimodal-judge-input-v1",
    headSha: "a".repeat(40),
    questions: [
      {
        id: QUESTION_ID,
        promptVersion: "proof-questions-v1",
        prompt: {
          trust: "untrusted",
          source: "stored_proof_question",
          content: "Explain the concrete behavior changed by anchor a0.",
        },
        patchAnchorIds: ["a0"],
        rubricVersion: "rubric-v1",
        criteria: [
          {
            id: CRITERION_A,
            description: {
              trust: "untrusted",
              source: "stored_rubric",
              content: "Identifies the concrete changed behavior.",
            },
            requiredTerms: [
              {
                trust: "untrusted",
                source: "stored_rubric",
                content: "changed behavior",
              },
            ],
          },
          {
            id: CRITERION_B,
            description: {
              trust: "untrusted",
              source: "stored_rubric",
              content: "Explains one observable consequence.",
            },
            requiredTerms: [
              {
                trust: "untrusted",
                source: "stored_rubric",
                content: "observable consequence",
              },
            ],
          },
        ],
      },
    ],
    patchAnchors: [
      {
        anchorId: "a0",
        filename: {
          trust: "untrusted",
          source: "bounded_patch_anchor",
          content: "apps/api/route.ts",
        },
        patch: {
          trust: "untrusted",
          source: "bounded_patch_anchor",
          content: "-return oldResponse\n+return newResponse",
        },
      },
    ],
    transcriptSegments: [
      {
        questionId: QUESTION_ID,
        startMs: 1_000,
        endMs: 4_000,
        text: {
          trust: "untrusted",
          source: "question_bound_transcript",
          content: "The question-bound transcript explains the new response.",
        },
      },
    ],
    timing: { recordingDurationMs: 10_000 },
    frames: [
      {
        id: "10000000-0000-4000-8000-000000000020",
        timestampMs: 2_000,
        reasonCode: "transcript_alignment",
        width: 320,
        height: 180,
        mediaType: "image/jpeg",
        jpegBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      },
    ],
  };
}

function validCandidate(): MultimodalJudgeCandidateV1 {
  return {
    schemaVersion: "1",
    candidateVersion: "multimodal-judge-candidate-v1",
    recommendation: "pass",
    questionEvaluations: [
      {
        questionId: QUESTION_ID,
        criterionResults: [
          {
            criterionId: CRITERION_A,
            result: "met",
            supportedPatchAnchorIds: ["a0"],
            reason: "patch_evidence_supports_criterion",
          },
          {
            criterionId: CRITERION_B,
            result: "met",
            supportedPatchAnchorIds: ["a0"],
            reason: "patch_evidence_supports_criterion",
          },
        ],
        contradictions: [],
        uncertainty: [],
      },
    ],
    privateReason: "all_stored_criteria_supported",
    warnings: [],
  };
}

function completionResponse(candidate: unknown): Response {
  return completionTextResponse(JSON.stringify({ result: candidate }));
}

function completionTextResponse(content: string): Response {
  const events = [
    {
      choices: [
        {
          delta: { reasoning: "private reasoning must never be persisted" },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    {
      choices: [{ delta: { content }, finish_reason: null }],
      usage: null,
    },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
    },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 25, completion_tokens: 10 },
    },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function fragmentedCompletionResponse(candidate: unknown): Response {
  const content = JSON.stringify({ result: candidate });
  const midpoint = Math.floor(content.length / 2);
  const events = [
    {
      choices: [
        { delta: { content: content.slice(0, midpoint) }, finish_reason: null },
      ],
    },
    {
      choices: [
        { delta: { content: content.slice(midpoint) }, finish_reason: null },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 25, completion_tokens: 10 },
    },
  ];
  const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(payload);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) {
          controller.enqueue(bytes.slice(offset, offset + 7));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
