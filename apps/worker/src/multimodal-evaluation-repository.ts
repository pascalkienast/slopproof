import { createHash } from "node:crypto";
import {
  EvaluationApplyPolicyJobSchema,
  expediteJobInPgTransaction,
  type DatabaseConnection,
  type JobPayload,
} from "@slopproof/db";
import { GitShaSchema, Sha256Schema, UuidSchema } from "@slopproof/domain";
import {
  ProofEvaluationV1Schema,
  multimodalJudgeCandidateHashV1,
  type PayloadCipher,
  type PayloadCipherEnvelopeV1,
  type ProofEvaluationV1,
} from "@slopproof/providers";
import type { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  MultimodalProofEvaluationV1Schema,
  type MultimodalProofEvaluationV1,
} from "./multimodal-judge-service";
import {
  EncryptedEvaluationBundleV1Schema,
  type EncryptedEvaluationBundleV1,
} from "./provider-pipeline-contracts";

const AAD_PREFIX = "slopproof:multimodal-evaluation-sidecar:v1";

const MultimodalEvaluationAadBindingV1Schema = z
  .object({
    attemptId: UuidSchema,
    revisionId: UuidSchema,
    headSha: GitShaSchema,
    evaluationId: UuidSchema,
    transcriptId: UuidSchema,
    inputHash: Sha256Schema,
  })
  .strict();

export type MultimodalEvaluationAadBindingV1 = z.infer<
  typeof MultimodalEvaluationAadBindingV1Schema
>;

const DownstreamJobBaseV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    idempotencyKey: z.string().min(1).max(200),
    attemptId: UuidSchema,
    expectedHeadSha: GitShaSchema,
  })
  .strict();

export type MultimodalEvaluationReplayInput = {
  attemptId: string;
  transcriptId: string;
  expectedHeadSha: string;
  downstreamJobBase: z.infer<typeof DownstreamJobBaseV1Schema>;
};

export type PersistMultimodalEvaluationPairInput = {
  multimodalEvaluation: MultimodalProofEvaluationV1;
  evaluationInputHash: string;
  transcriptId: string;
  deleteAfter: Date;
  compatibilityEvaluation: EncryptedEvaluationBundleV1;
  downstreamJob: JobPayload<"evaluation.apply-policy">;
};

export type PersistedMultimodalEvaluationPair = {
  sidecarId: string;
  multimodalEvaluation: MultimodalProofEvaluationV1;
  compatibilityEvaluation: EncryptedEvaluationBundleV1;
  downstreamScheduled: boolean;
};

export type MultimodalEvaluationPairPersistenceResult =
  PersistedMultimodalEvaluationPair & {
    status: "created" | "replayed";
  };

export interface MultimodalEvaluationRepository {
  loadExistingAndSchedule(
    input: MultimodalEvaluationReplayInput,
  ): Promise<PersistedMultimodalEvaluationPair | null>;
  persistPair(
    input: PersistMultimodalEvaluationPairInput,
  ): Promise<MultimodalEvaluationPairPersistenceResult>;
}

/** No payload, model response, or transcript content is included in errors. */
export class MultimodalEvaluationPersistenceError extends Error {
  readonly code = "MULTIMODAL_EVALUATION_PERSISTENCE_ERROR" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MultimodalEvaluationPersistenceError";
  }
}

type SidecarRow = {
  sidecar_id: string;
  attempt_id: string;
  revision_id: string;
  head_sha: string;
  evaluation_id: string;
  transcript_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  evaluation_version: string;
  output_schema_version: string;
  input_hash: string;
  output_hash: string;
  encrypted_payload: unknown | null;
  provider_completed_at: Date;
  delete_after: Date;
  deleted_at: Date | null;
  attempt_status: string;
  is_current: boolean;
  pull_request_state: string;
  repository_status: string;
  installation_status: string;
  transcript_active: boolean;
  evaluation_active: boolean;
  recording_active: boolean;
  evaluation_provider: string;
  evaluation_model: string;
  compatibility_prompt_version: string;
  compatibility_schema_version: string;
  rubric_version: string;
  recommendation: "pass" | "review_required" | "retry";
  encrypted_evaluation: string;
  evaluation_delete_after: Date;
};

type ValidatedPairInput = {
  multimodalEvaluation: MultimodalProofEvaluationV1;
  evaluationInputHash: string;
  transcriptId: string;
  deleteAfter: Date;
  compatibilityEvaluation: EncryptedEvaluationBundleV1;
  compatibilityPlaintext: ProofEvaluationV1;
  downstreamJob: JobPayload<"evaluation.apply-policy">;
  sidecarId: string;
  encryptedSidecar: PayloadCipherEnvelopeV1;
};

export function multimodalEvaluationAadV1(
  rawBinding: MultimodalEvaluationAadBindingV1,
): string {
  const binding = MultimodalEvaluationAadBindingV1Schema.safeParse(rawBinding);
  if (!binding.success) {
    throw new MultimodalEvaluationPersistenceError(
      "Multimodal evaluation AAD binding is invalid",
      { cause: binding.error },
    );
  }
  return [
    AAD_PREFIX,
    binding.data.attemptId,
    binding.data.revisionId,
    binding.data.headSha,
    binding.data.evaluationId,
    binding.data.transcriptId,
    binding.data.inputHash,
  ].join(":");
}

/**
 * Decrypts the authoritative result with an exact two-path Date revival. The
 * mutable plaintext byte buffer is always wiped before control returns.
 */
export function decryptMultimodalEvaluationSidecarV1(
  cipher: Pick<PayloadCipher, "decrypt">,
  rawEnvelope: unknown,
  rawBinding: MultimodalEvaluationAadBindingV1,
): MultimodalProofEvaluationV1 {
  const aad = multimodalEvaluationAadV1(rawBinding);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = cipher.decrypt(rawEnvelope, aad);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(decoded);
    return MultimodalProofEvaluationV1Schema.parse(
      reviveMultimodalEvaluationDates(parsed),
    );
  } catch (error) {
    throw new MultimodalEvaluationPersistenceError(
      "Authoritative multimodal evaluation could not be authenticated",
      { cause: error },
    );
  } finally {
    plaintext?.fill(0);
  }
}

export class PostgresMultimodalEvaluationRepository implements MultimodalEvaluationRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly payloadCipher: PayloadCipher,
    private readonly queue?: PgBoss,
  ) {}

  async loadExistingAndSchedule(
    rawInput: MultimodalEvaluationReplayInput,
  ): Promise<PersistedMultimodalEvaluationPair | null> {
    const input = parseReplayInput(rawInput);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAttempt(client, input.attemptId);
      const rows = await loadSidecarRows(client, input.attemptId);
      if (rows.length === 0) {
        await requireNoCompatibilityOnlyEvaluation(client, input.attemptId);
        await client.query("COMMIT");
        return null;
      }
      const row = requireSingleRow(rows);
      requireReplayAvailability(row, {
        attemptId: input.attemptId,
        transcriptId: input.transcriptId,
        expectedHeadSha: input.expectedHeadSha,
      });
      const pair = this.decodeStoredPair(row);
      const downstreamScheduled = await this.scheduleIfEligible(
        client,
        row,
        EvaluationApplyPolicyJobSchema.parse({
          ...input.downstreamJobBase,
          evaluationId: row.evaluation_id,
        }),
      );
      await client.query("COMMIT");
      return { ...pair, downstreamScheduled };
    } catch (error) {
      await client.query("ROLLBACK");
      throw asPersistenceError(error);
    } finally {
      client.release();
    }
  }

  async persistPair(
    rawInput: PersistMultimodalEvaluationPairInput,
  ): Promise<MultimodalEvaluationPairPersistenceResult> {
    const input = this.validatePairInput(rawInput);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await lockAttempt(client, input.multimodalEvaluation.attemptId);
      const rows = await loadSidecarRows(
        client,
        input.multimodalEvaluation.attemptId,
      );
      if (rows.length > 0) {
        const row = requireSingleRow(rows);
        requireReplayAvailability(row, {
          attemptId: input.multimodalEvaluation.attemptId,
          transcriptId: input.transcriptId,
          expectedHeadSha: input.multimodalEvaluation.headSha,
        });
        const stored = this.decodeStoredPair(row);
        requireExactReplay(
          stored,
          decryptCompatibilityEvaluation(
            this.payloadCipher,
            stored.compatibilityEvaluation,
          ),
          row,
          input,
        );
        const downstreamScheduled = await this.scheduleIfEligible(
          client,
          row,
          input.downstreamJob,
        );
        await client.query("COMMIT");
        return {
          status: "replayed",
          ...stored,
          downstreamScheduled,
        };
      }

      const strayEvaluation = await client.query(
        `SELECT id FROM evaluations WHERE attempt_id = $1
         ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
        [input.multimodalEvaluation.attemptId],
      );
      if ((strayEvaluation.rowCount ?? 0) !== 0) {
        throw new MultimodalEvaluationPersistenceError(
          "Compatibility evaluation exists without its authoritative sidecar",
        );
      }

      const insertedEvaluation = await client.query(
        `INSERT INTO evaluations
           (id, attempt_id, provider, model, prompt_version, schema_version,
            rubric_version, encrypted_payload, recommendation, delete_after)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, recording.delete_after
           FROM attempts attempt
           JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
             AND pull_request.repository_id = attempt.repository_id
           JOIN repositories repository ON repository.id = attempt.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
           JOIN recording_objects recording ON recording.attempt_id = attempt.id
           JOIN transcripts transcript ON transcript.id = $10
             AND transcript.attempt_id = attempt.id
          WHERE attempt.id = $2 AND attempt.revision_id = $11
            AND attempt.head_sha = $12 AND revision.head_sha = $12
            AND attempt.status = 'processing' AND revision.is_current = true
            AND pull_request.state = 'open' AND repository.status = 'active'
            AND installation.status = 'active'
            AND attempt.evidence_delete_after = $13
            AND recording.delete_after = $13 AND recording.deleted_at IS NULL
            AND transcript.delete_after = $13 AND transcript.deleted_at IS NULL
            AND $13 > clock_timestamp()
         RETURNING id`,
        [
          input.compatibilityEvaluation.evaluationId,
          input.compatibilityEvaluation.attemptId,
          input.compatibilityEvaluation.provider,
          input.compatibilityEvaluation.model,
          input.compatibilityEvaluation.promptVersion,
          input.compatibilityEvaluation.evaluationSchemaVersion,
          input.compatibilityEvaluation.rubricVersion,
          input.compatibilityEvaluation.encryptedPayload,
          input.compatibilityEvaluation.recommendation,
          input.transcriptId,
          input.multimodalEvaluation.revisionId,
          input.multimodalEvaluation.headSha,
          input.deleteAfter,
        ],
      );
      if (insertedEvaluation.rowCount !== 1) {
        throw new MultimodalEvaluationPersistenceError(
          "Multimodal evaluation lifecycle is unavailable",
        );
      }

      await client.query(
        `INSERT INTO multimodal_evaluation_sidecars_v1
           (id, attempt_id, revision_id, head_sha, evaluation_id,
            transcript_id, provider, model, prompt_version,
            evaluation_version, output_schema_version, input_hash,
            output_hash, encrypted_payload, provider_completed_at,
            delete_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14::jsonb, $15, $16)`,
        [
          input.sidecarId,
          input.multimodalEvaluation.attemptId,
          input.multimodalEvaluation.revisionId,
          input.multimodalEvaluation.headSha,
          input.compatibilityEvaluation.evaluationId,
          input.transcriptId,
          input.multimodalEvaluation.invocationMetadata.provider,
          input.multimodalEvaluation.invocationMetadata.model,
          input.multimodalEvaluation.invocationMetadata.promptVersion,
          input.multimodalEvaluation.evaluationVersion,
          input.multimodalEvaluation.invocationMetadata.outputSchemaVersion,
          input.evaluationInputHash,
          input.multimodalEvaluation.invocationMetadata.outputHash,
          JSON.stringify(input.encryptedSidecar),
          input.multimodalEvaluation.invocationMetadata.completedAt,
          input.deleteAfter,
        ],
      );

      const downstreamScheduled = await this.scheduleIfEligible(
        client,
        { attempt_status: "processing" },
        input.downstreamJob,
      );
      await client.query("COMMIT");
      return {
        status: "created",
        sidecarId: input.sidecarId,
        multimodalEvaluation: input.multimodalEvaluation,
        compatibilityEvaluation: input.compatibilityEvaluation,
        downstreamScheduled,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw asPersistenceError(error);
    } finally {
      client.release();
    }
  }

  private validatePairInput(
    rawInput: PersistMultimodalEvaluationPairInput,
  ): ValidatedPairInput {
    try {
      const multimodalEvaluation = MultimodalProofEvaluationV1Schema.parse(
        rawInput.multimodalEvaluation,
      );
      const evaluationInputHash = Sha256Schema.parse(
        rawInput.evaluationInputHash,
      );
      const transcriptId = UuidSchema.parse(rawInput.transcriptId);
      const compatibilityEvaluation = EncryptedEvaluationBundleV1Schema.parse(
        rawInput.compatibilityEvaluation,
      );
      const downstreamJob = EvaluationApplyPolicyJobSchema.parse(
        rawInput.downstreamJob,
      );
      const deleteAfter = validDate(rawInput.deleteAfter, "deleteAfter");
      if (
        multimodalEvaluation.invocationMetadata.inputHash !==
          evaluationInputHash ||
        multimodalEvaluation.invocationMetadata.outputHash !==
          multimodalJudgeCandidateHashV1(multimodalEvaluation.candidate) ||
        compatibilityEvaluation.attemptId !== multimodalEvaluation.attemptId ||
        compatibilityEvaluation.deleteAfter.getTime() !==
          deleteAfter.getTime() ||
        compatibilityEvaluation.recommendation !== "review_required" ||
        downstreamJob.attemptId !== multimodalEvaluation.attemptId ||
        downstreamJob.expectedHeadSha !== multimodalEvaluation.headSha ||
        downstreamJob.evaluationId !== compatibilityEvaluation.evaluationId ||
        multimodalEvaluation.invocationMetadata.completedAt.getTime() >
          multimodalEvaluation.createdAt.getTime() ||
        deleteAfter.getTime() <= multimodalEvaluation.createdAt.getTime()
      ) {
        throw new MultimodalEvaluationPersistenceError(
          "Multimodal evaluation pair binding is invalid",
        );
      }
      const compatibilityPlaintext = decryptCompatibilityEvaluation(
        this.payloadCipher,
        compatibilityEvaluation,
      );
      requireHonestCompatibilityProjection(
        multimodalEvaluation,
        compatibilityEvaluation,
        compatibilityPlaintext,
      );
      const binding = {
        attemptId: multimodalEvaluation.attemptId,
        revisionId: multimodalEvaluation.revisionId,
        headSha: multimodalEvaluation.headSha,
        evaluationId: compatibilityEvaluation.evaluationId,
        transcriptId,
        inputHash: evaluationInputHash,
      };
      const sidecarId = deterministicUuid(
        `multimodal-sidecar-v1:${multimodalEvaluation.attemptId}:${multimodalEvaluation.revisionId}:${multimodalEvaluation.headSha}:${compatibilityEvaluation.evaluationId}:${transcriptId}:${evaluationInputHash}`,
      );
      return {
        multimodalEvaluation,
        evaluationInputHash,
        transcriptId,
        deleteAfter,
        compatibilityEvaluation,
        compatibilityPlaintext,
        downstreamJob,
        sidecarId,
        encryptedSidecar: this.payloadCipher.encryptJson(
          multimodalEvaluation,
          multimodalEvaluationAadV1(binding),
        ),
      };
    } catch (error) {
      throw asPersistenceError(error);
    }
  }

  private decodeStoredPair(row: SidecarRow): PersistedMultimodalEvaluationPair {
    try {
      if (row.encrypted_payload === null || row.deleted_at !== null) {
        throw new MultimodalEvaluationPersistenceError(
          "Authoritative multimodal evaluation was retention-shredded",
        );
      }
      const multimodalEvaluation = decryptMultimodalEvaluationSidecarV1(
        this.payloadCipher,
        row.encrypted_payload,
        rowBinding(row),
      );
      requireStoredMetadata(row, multimodalEvaluation);
      const compatibilityEvaluation = compatibilityBundle(row);
      const compatibilityPlaintext = decryptCompatibilityEvaluation(
        this.payloadCipher,
        compatibilityEvaluation,
      );
      requireHonestCompatibilityProjection(
        multimodalEvaluation,
        compatibilityEvaluation,
        compatibilityPlaintext,
      );
      return {
        sidecarId: row.sidecar_id,
        multimodalEvaluation,
        compatibilityEvaluation,
        downstreamScheduled: false,
      };
    } catch (error) {
      throw asPersistenceError(error);
    }
  }

  private async scheduleIfEligible(
    client: PoolClient,
    row: Pick<SidecarRow, "attempt_status">,
    downstreamJob: JobPayload<"evaluation.apply-policy">,
  ): Promise<boolean> {
    if (this.queue === undefined || row.attempt_status !== "processing") {
      return false;
    }
    await expediteJobInPgTransaction(
      this.queue,
      client,
      "evaluation.apply-policy",
      downstreamJob,
    );
    return true;
  }
}

function parseReplayInput(
  rawInput: MultimodalEvaluationReplayInput,
): MultimodalEvaluationReplayInput {
  try {
    const parsed = z
      .object({
        attemptId: UuidSchema,
        transcriptId: UuidSchema,
        expectedHeadSha: GitShaSchema,
        downstreamJobBase: DownstreamJobBaseV1Schema,
      })
      .strict()
      .parse(rawInput);
    if (
      parsed.downstreamJobBase.attemptId !== parsed.attemptId ||
      parsed.downstreamJobBase.expectedHeadSha !== parsed.expectedHeadSha
    ) {
      throw new MultimodalEvaluationPersistenceError(
        "Multimodal replay job binding is invalid",
      );
    }
    return parsed;
  } catch (error) {
    throw asPersistenceError(error);
  }
}

async function lockAttempt(client: PoolClient, attemptId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `multimodal-evaluation:${attemptId}`,
  ]);
}

async function loadSidecarRows(
  client: PoolClient,
  attemptId: string,
): Promise<SidecarRow[]> {
  const result = await client.query<SidecarRow>(
    `SELECT sidecar.id AS sidecar_id, sidecar.attempt_id,
            sidecar.revision_id, sidecar.head_sha, sidecar.evaluation_id,
            sidecar.transcript_id, sidecar.provider, sidecar.model,
            sidecar.prompt_version, sidecar.evaluation_version,
            sidecar.output_schema_version, sidecar.input_hash,
            sidecar.output_hash, sidecar.encrypted_payload,
            sidecar.provider_completed_at, sidecar.delete_after,
            sidecar.deleted_at, attempt.status AS attempt_status,
            revision.is_current, pull_request.state AS pull_request_state,
            repository.status AS repository_status,
            installation.status AS installation_status,
            (transcript.deleted_at IS NULL
             AND transcript.delete_after > clock_timestamp()
             AND transcript.delete_after = sidecar.delete_after)
              AS transcript_active,
            (evaluation.deleted_at IS NULL
             AND evaluation.delete_after > clock_timestamp()
             AND evaluation.delete_after = sidecar.delete_after)
              AS evaluation_active,
            (recording.deleted_at IS NULL
             AND recording.delete_after > clock_timestamp()
             AND recording.delete_after = sidecar.delete_after)
              AS recording_active,
            evaluation.provider AS evaluation_provider,
            evaluation.model AS evaluation_model,
            evaluation.prompt_version AS compatibility_prompt_version,
            evaluation.schema_version AS compatibility_schema_version,
            evaluation.rubric_version, evaluation.recommendation,
            evaluation.encrypted_payload AS encrypted_evaluation,
            evaluation.delete_after AS evaluation_delete_after
       FROM multimodal_evaluation_sidecars_v1 sidecar
       JOIN attempts attempt ON attempt.id = sidecar.attempt_id
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         AND revision.id = sidecar.revision_id
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
         AND pull_request.repository_id = attempt.repository_id
       JOIN repositories repository ON repository.id = attempt.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
       JOIN recording_objects recording ON recording.attempt_id = attempt.id
       JOIN transcripts transcript ON transcript.id = sidecar.transcript_id
         AND transcript.attempt_id = attempt.id
       JOIN evaluations evaluation ON evaluation.id = sidecar.evaluation_id
         AND evaluation.attempt_id = attempt.id
      WHERE sidecar.attempt_id = $1
      ORDER BY sidecar.created_at, sidecar.id
      LIMIT 2
      FOR UPDATE OF sidecar, attempt, revision, pull_request, repository,
                    installation, recording, transcript, evaluation`,
    [attemptId],
  );
  return result.rows;
}

async function requireNoCompatibilityOnlyEvaluation(
  client: PoolClient,
  attemptId: string,
): Promise<void> {
  const existing = await client.query(
    `SELECT id FROM evaluations WHERE attempt_id = $1
     ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
    [attemptId],
  );
  if ((existing.rowCount ?? 0) !== 0) {
    throw new MultimodalEvaluationPersistenceError(
      "Compatibility evaluation exists without its authoritative sidecar",
    );
  }
}

function requireSingleRow(rows: SidecarRow[]): SidecarRow {
  if (rows.length !== 1) {
    throw new MultimodalEvaluationPersistenceError(
      "Authoritative multimodal evaluation cardinality is invalid",
    );
  }
  return rows[0]!;
}

function requireReplayAvailability(
  row: SidecarRow,
  input: { attemptId: string; transcriptId: string; expectedHeadSha: string },
) {
  if (
    row.attempt_id !== input.attemptId ||
    row.transcript_id !== input.transcriptId ||
    row.head_sha !== input.expectedHeadSha ||
    !row.is_current ||
    row.pull_request_state !== "open" ||
    row.repository_status !== "active" ||
    row.installation_status !== "active" ||
    !row.transcript_active ||
    !row.evaluation_active ||
    !row.recording_active ||
    row.deleted_at !== null ||
    (row.attempt_status !== "processing" &&
      row.attempt_status !== "review_required")
  ) {
    throw new MultimodalEvaluationPersistenceError(
      "Authoritative multimodal evaluation is unavailable",
    );
  }
}

function rowBinding(row: SidecarRow): MultimodalEvaluationAadBindingV1 {
  return {
    attemptId: row.attempt_id,
    revisionId: row.revision_id,
    headSha: row.head_sha,
    evaluationId: row.evaluation_id,
    transcriptId: row.transcript_id,
    inputHash: row.input_hash,
  };
}

function compatibilityBundle(row: SidecarRow): EncryptedEvaluationBundleV1 {
  return EncryptedEvaluationBundleV1Schema.parse({
    schemaVersion: "1",
    payloadKind: "proof_evaluation",
    evaluationId: row.evaluation_id,
    attemptId: row.attempt_id,
    provider: row.evaluation_provider,
    model: row.evaluation_model,
    promptVersion: row.compatibility_prompt_version,
    evaluationSchemaVersion: row.compatibility_schema_version,
    rubricVersion: row.rubric_version,
    recommendation: row.recommendation,
    encryptedPayload: row.encrypted_evaluation,
    deleteAfter: row.evaluation_delete_after,
  });
}

function requireStoredMetadata(
  row: SidecarRow,
  evaluation: MultimodalProofEvaluationV1,
) {
  const metadata = evaluation.invocationMetadata;
  const expectedSidecarId = deterministicUuid(
    `multimodal-sidecar-v1:${row.attempt_id}:${row.revision_id}:${row.head_sha}:${row.evaluation_id}:${row.transcript_id}:${row.input_hash}`,
  );
  if (
    row.sidecar_id !== expectedSidecarId ||
    evaluation.attemptId !== row.attempt_id ||
    evaluation.revisionId !== row.revision_id ||
    evaluation.headSha !== row.head_sha ||
    evaluation.evaluationVersion !== row.evaluation_version ||
    metadata.provider !== row.provider ||
    metadata.model !== row.model ||
    metadata.promptVersion !== row.prompt_version ||
    metadata.outputSchemaVersion !== row.output_schema_version ||
    metadata.inputHash !== row.input_hash ||
    metadata.outputHash !== row.output_hash ||
    metadata.outputHash !==
      multimodalJudgeCandidateHashV1(evaluation.candidate) ||
    metadata.completedAt.getTime() !== row.provider_completed_at.getTime()
  ) {
    throw new MultimodalEvaluationPersistenceError(
      "Authoritative multimodal evaluation metadata is inconsistent",
    );
  }
}

function requireExactReplay(
  stored: PersistedMultimodalEvaluationPair,
  storedCompatibilityPlaintext: ProofEvaluationV1,
  row: SidecarRow,
  input: ValidatedPairInput,
) {
  if (
    row.sidecar_id !== input.sidecarId ||
    row.input_hash !== input.evaluationInputHash ||
    row.delete_after.getTime() !== input.deleteAfter.getTime() ||
    stableJson(stored.multimodalEvaluation) !==
      stableJson(input.multimodalEvaluation) ||
    stableJson(storedCompatibilityPlaintext) !==
      stableJson(input.compatibilityPlaintext) ||
    stableJson({
      ...stored.compatibilityEvaluation,
      encryptedPayload: undefined,
    }) !==
      stableJson({
        ...input.compatibilityEvaluation,
        encryptedPayload: undefined,
      })
  ) {
    throw new MultimodalEvaluationPersistenceError(
      "Conflicting multimodal evaluation replay",
    );
  }
}

function requireHonestCompatibilityProjection(
  authoritative: MultimodalProofEvaluationV1,
  bundle: EncryptedEvaluationBundleV1,
  compatibility: ProofEvaluationV1,
) {
  if (
    bundle.recommendation !== "review_required" ||
    compatibility.recommendation !== "review_required" ||
    compatibility.attemptId !== authoritative.attemptId ||
    compatibility.revisionId !== authoritative.revisionId ||
    compatibility.headSha !== authoritative.headSha ||
    compatibility.provider !== bundle.provider ||
    compatibility.model !== bundle.model ||
    compatibility.systemInstructionVersion !== bundle.promptVersion ||
    compatibility.evaluationVersion !== bundle.evaluationSchemaVersion
  ) {
    throw new MultimodalEvaluationPersistenceError(
      "Compatibility evaluation is not a safe manual-review projection",
    );
  }
  const compatibilityByQuestion = new Map(
    compatibility.questionEvaluations.map((question) => [
      question.questionId,
      question,
    ]),
  );
  if (
    compatibilityByQuestion.size !==
    authoritative.candidate.questionEvaluations.length
  ) {
    throw new MultimodalEvaluationPersistenceError(
      "Compatibility evaluation question binding is invalid",
    );
  }
  for (const question of authoritative.candidate.questionEvaluations) {
    const projected = compatibilityByQuestion.get(question.questionId);
    if (projected === undefined) {
      throw new MultimodalEvaluationPersistenceError(
        "Compatibility evaluation question binding is invalid",
      );
    }
    const authoritativeByCriterion = new Map(
      question.criterionResults.map((criterion) => [
        criterion.criterionId,
        criterion,
      ]),
    );
    const evaluable = question.criterionResults.filter(
      (criterion) => criterion.result !== "not_evaluable",
    );
    const notEvaluableIds = new Set(
      question.criterionResults
        .filter((criterion) => criterion.result === "not_evaluable")
        .map((criterion) => criterion.criterionId),
    );
    const expectedOutcome = compatibilityQuestionOutcome(
      question.criterionResults.map((criterion) => criterion.result),
    );
    const expectedAnchors = [
      ...new Set(
        question.criterionResults.flatMap(
          (criterion) => criterion.supportedPatchAnchorIds,
        ),
      ),
    ].sort();
    const projectedAnchors = [...projected.supportedPatchAnchorIds].sort();
    const projectedKnownFindings = projected.rubricFindings.filter((finding) =>
      authoritativeByCriterion.has(finding.criterionId),
    );
    const projectedSentinels = projected.rubricFindings.filter(
      (finding) => !authoritativeByCriterion.has(finding.criterionId),
    );
    if (
      projected.outcome !== expectedOutcome ||
      stableJson(projectedAnchors) !== stableJson(expectedAnchors) ||
      projectedKnownFindings.length !== evaluable.length ||
      projectedKnownFindings.some((finding) => {
        const source = authoritativeByCriterion.get(finding.criterionId);
        return (
          source === undefined ||
          source.result === "not_evaluable" ||
          source.result !== finding.result
        );
      }) ||
      projected.rubricFindings.some((finding) =>
        notEvaluableIds.has(finding.criterionId),
      ) ||
      (evaluable.length > 0 && projectedSentinels.length !== 0) ||
      (evaluable.length === 0 &&
        (projectedSentinels.length !== 1 ||
          projectedSentinels[0]?.result !== "met" ||
          projectedSentinels[0]?.reason !==
            "Compatibility-only sentinel; consult authoritative sidecar."))
    ) {
      throw new MultimodalEvaluationPersistenceError(
        "Compatibility evaluation misrepresents unavailable evidence",
      );
    }
  }
}

function compatibilityQuestionOutcome(
  results: Array<"met" | "not_met" | "not_evaluable">,
): "met" | "partial" | "not_met" | "not_evaluable" {
  if (results.includes("not_evaluable")) return "not_evaluable";
  if (results.every((result) => result === "met")) return "met";
  if (results.every((result) => result === "not_met")) return "not_met";
  return "partial";
}

function decryptCompatibilityEvaluation(
  cipher: Pick<PayloadCipher, "decrypt">,
  bundle: EncryptedEvaluationBundleV1,
): ProofEvaluationV1 {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = cipher.decrypt(
      JSON.parse(bundle.encryptedPayload),
      `slopproof:evaluation:v1:${bundle.attemptId}:${bundle.evaluationId}`,
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const parsed: unknown = JSON.parse(decoded);
    if (!isRecord(parsed)) return ProofEvaluationV1Schema.parse(parsed);
    return ProofEvaluationV1Schema.parse({
      ...parsed,
      createdAt: reviveExactIsoDate(parsed.createdAt, "createdAt"),
    });
  } catch (error) {
    throw new MultimodalEvaluationPersistenceError(
      "Compatibility evaluation could not be authenticated",
      { cause: error },
    );
  } finally {
    plaintext?.fill(0);
  }
}

function reviveMultimodalEvaluationDates(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.invocationMetadata)) return value;
  return {
    ...value,
    createdAt: reviveExactIsoDate(value.createdAt, "createdAt"),
    invocationMetadata: {
      ...value.invocationMetadata,
      completedAt: reviveExactIsoDate(
        value.invocationMetadata.completedAt,
        "invocationMetadata.completedAt",
      ),
    },
  };
}

function reviveExactIsoDate(value: unknown, field: string): Date {
  if (typeof value !== "string") {
    throw new MultimodalEvaluationPersistenceError(
      `Encrypted multimodal evaluation ${field} is not an ISO date`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MultimodalEvaluationPersistenceError(
      `Encrypted multimodal evaluation ${field} is not an exact ISO date`,
    );
  }
  return parsed;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new MultimodalEvaluationPersistenceError(
        "Multimodal evaluation contains a non-finite number",
      );
    }
    return JSON.stringify(value) ?? "undefined";
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function validDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new MultimodalEvaluationPersistenceError(
      `Multimodal evaluation ${field} is invalid`,
    );
  }
  return new Date(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPersistenceError(
  error: unknown,
): MultimodalEvaluationPersistenceError {
  return error instanceof MultimodalEvaluationPersistenceError
    ? error
    : new MultimodalEvaluationPersistenceError(
        "Authoritative multimodal evaluation persistence failed",
        { cause: error },
      );
}
