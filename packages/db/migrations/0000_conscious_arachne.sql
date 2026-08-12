CREATE TYPE "public"."attempt_status" AS ENUM('preparing', 'ready', 'active', 'uploading', 'processing', 'review_required', 'passed', 'retry_required', 'technical_retry', 'expired', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."check_conclusion" AS ENUM('action_required', 'success', 'neutral', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('queued', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."deletion_job_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('pass', 'retry');--> statement-breakpoint
CREATE TABLE "analysis_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"analyzer_version" text NOT NULL,
	"diff_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"from_status" "attempt_status" NOT NULL,
	"to_status" "attempt_status" NOT NULL,
	"expected_head_sha" text NOT NULL,
	"current_head_sha" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"proof_plan_id" uuid NOT NULL,
	"head_sha" text NOT NULL,
	"status" "attempt_status" NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_head_sha_format" CHECK ("attempts"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "attempts_expiry_after_creation" CHECK ("attempts"."expires_at" > "attempts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"repository_id" uuid,
	"csrf_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"github_check_run_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "check_status" NOT NULL,
	"conclusion" "check_conclusion",
	"public_summary" text NOT NULL,
	"details_url" text NOT NULL,
	"last_synchronized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_class" text NOT NULL,
	"object_id" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"state" "deletion_job_state" DEFAULT 'pending' NOT NULL,
	"last_error_class" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_jobs_attempts_nonnegative" CHECK ("deletion_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"rubric_version" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"recommendation" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frame_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"reason_code" text NOT NULL,
	"object_key" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "frame_selections_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "handoff_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"desktop_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" text NOT NULL,
	"account_id" text NOT NULL,
	"account_login" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "practice_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proof_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"plan_version" text NOT NULL,
	"deterministic_seed" text NOT NULL,
	"risk_explanation" jsonb NOT NULL,
	"question_budget" integer NOT NULL,
	"plan_hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_plans_question_budget" CHECK ("proof_plans"."question_budget" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "proof_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proof_plan_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"prompt" text NOT NULL,
	"diff_anchor" jsonb NOT NULL,
	"rubric" jsonb NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "proof_questions_ordinal_nonnegative" CHECK ("proof_questions"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pull_request_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pull_request_id" uuid NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "pull_request_revisions_head_sha_format" CHECK ("pull_request_revisions"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "pull_request_revisions_base_sha_format" CHECK ("pull_request_revisions"."base_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"github_pull_request_id" text NOT NULL,
	"number" integer NOT NULL,
	"author_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_requests_number_positive" CHECK ("pull_requests"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "recording_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"wrapped_data_key" text NOT NULL,
	"wrapped_key_sha256" text NOT NULL,
	"wrapping_material_id" uuid NOT NULL,
	"protocol_version" text NOT NULL,
	"algorithm" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"codec" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_objects_bytes_positive" CHECK ("recording_objects"."byte_length" > 0),
	CONSTRAINT "recording_objects_duration_positive" CHECK ("recording_objects"."duration_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "recording_parts" (
	"upload_session_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"first_chunk_index" integer NOT NULL,
	"last_chunk_index" integer NOT NULL,
	"byte_length" bigint NOT NULL,
	"sha256" text NOT NULL,
	"etag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_parts_upload_session_id_part_number_pk" PRIMARY KEY("upload_session_id","part_number"),
	CONSTRAINT "recording_parts_part_positive" CHECK ("recording_parts"."part_number" > 0),
	CONSTRAINT "recording_parts_chunk_range" CHECK ("recording_parts"."first_chunk_index" >= 0 AND "recording_parts"."last_chunk_index" >= "recording_parts"."first_chunk_index"),
	CONSTRAINT "recording_parts_bytes_positive" CHECK ("recording_parts"."byte_length" > 0)
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repository_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"active_policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" text NOT NULL,
	"policy" jsonb NOT NULL,
	"policy_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_policies_version_positive" CHECK ("repository_policies"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"maintainer_id" text NOT NULL,
	"decision" "review_decision" NOT NULL,
	"reason_code" text NOT NULL,
	"explanation" text,
	"head_sha" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"schema_version" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"provider_upload_id" text NOT NULL,
	"state" text NOT NULL,
	"next_part_number" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"manifest_digest" text,
	"finalize_envelope" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_next_part_positive" CHECK ("upload_sessions"."next_part_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"payload_hash" text NOT NULL,
	"processing_status" text DEFAULT 'reserved' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wrapping_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"algorithm" text NOT NULL,
	"spki_sha256" text NOT NULL,
	"usable_until" timestamp with time zone NOT NULL,
	"destroyed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_snapshots" ADD CONSTRAINT "analysis_snapshots_revision_id_pull_request_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."pull_request_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_transitions" ADD CONSTRAINT "attempt_transitions_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_revision_id_pull_request_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."pull_request_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_proof_plan_id_proof_plans_id_fk" FOREIGN KEY ("proof_plan_id") REFERENCES "public"."proof_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_revision_id_pull_request_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."pull_request_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_selections" ADD CONSTRAINT "frame_selections_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_tokens" ADD CONSTRAINT "handoff_tokens_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_tokens" ADD CONSTRAINT "handoff_tokens_desktop_session_id_auth_sessions_id_fk" FOREIGN KEY ("desktop_session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_revision_id_pull_request_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."pull_request_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_plans" ADD CONSTRAINT "proof_plans_revision_id_pull_request_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."pull_request_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_questions" ADD CONSTRAINT "proof_questions_proof_plan_id_proof_plans_id_fk" FOREIGN KEY ("proof_plan_id") REFERENCES "public"."proof_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_revisions" ADD CONSTRAINT "pull_request_revisions_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_objects" ADD CONSTRAINT "recording_objects_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_objects" ADD CONSTRAINT "recording_objects_wrapping_material_id_wrapping_materials_id_fk" FOREIGN KEY ("wrapping_material_id") REFERENCES "public"."wrapping_materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_parts" ADD CONSTRAINT "recording_parts_upload_session_id_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_policies" ADD CONSTRAINT "repository_policies_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wrapping_materials" ADD CONSTRAINT "wrapping_materials_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_snapshots_version_uq" ON "analysis_snapshots" USING btree ("revision_id","analyzer_version","diff_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_transitions_idempotency_uq" ON "attempt_transitions" USING btree ("attempt_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_active_per_author_revision_uq" ON "attempts" USING btree ("revision_id","author_id") WHERE "attempts"."status" IN ('preparing','ready','active','uploading','processing','review_required');--> statement-breakpoint
CREATE INDEX "attempts_review_queue_idx" ON "attempts" USING btree ("repository_id","created_at") WHERE "attempts"."status" = 'review_required';--> statement-breakpoint
CREATE INDEX "audit_events_object_idx" ON "audit_events" USING btree ("object_type","object_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_uq" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_expiry_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "check_runs_revision_uq" ON "check_runs" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "check_runs_github_id_uq" ON "check_runs" USING btree ("github_check_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_jobs_object_uq" ON "deletion_jobs" USING btree ("object_class","object_id");--> statement-breakpoint
CREATE INDEX "deletion_jobs_deadline_idx" ON "deletion_jobs" USING btree ("state","deadline");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_version_tuple_uq" ON "evaluations" USING btree ("attempt_id","provider","model","prompt_version","schema_version","rubric_version");--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_tokens_token_hash_uq" ON "handoff_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "handoff_tokens_one_open_attempt_uq" ON "handoff_tokens" USING btree ("attempt_id") WHERE "handoff_tokens"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "handoff_tokens_expiry_idx" ON "handoff_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_plans_hash_uq" ON "proof_plans" USING btree ("revision_id","plan_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_questions_ordinal_uq" ON "proof_questions" USING btree ("proof_plan_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_revisions_sha_uq" ON "pull_request_revisions" USING btree ("pull_request_id","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_revisions_one_current_uq" ON "pull_request_revisions" USING btree ("pull_request_id") WHERE "pull_request_revisions"."is_current" = true;--> statement-breakpoint
CREATE INDEX "pull_request_revisions_current_idx" ON "pull_request_revisions" USING btree ("pull_request_id","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_repo_number_uq" ON "pull_requests" USING btree ("repository_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_requests_github_id_uq" ON "pull_requests" USING btree ("github_pull_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_objects_attempt_uq" ON "recording_objects" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_objects_object_key_uq" ON "recording_objects" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_objects_wrapped_key_hash_uq" ON "recording_objects" USING btree ("wrapped_key_sha256");--> statement-breakpoint
CREATE INDEX "recording_objects_deletion_deadline_idx" ON "recording_objects" USING btree ("delete_after","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_parts_chunk_range_uq" ON "recording_parts" USING btree ("upload_session_id","first_chunk_index","last_chunk_index");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_github_id_uq" ON "repositories" USING btree ("github_repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_owner_name_uq" ON "repositories" USING btree ("owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_policies_version_uq" ON "repository_policies" USING btree ("repository_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_policies_hash_uq" ON "repository_policies" USING btree ("repository_id","policy_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_attempt_uq" ON "upload_sessions" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_object_key_uq" ON "upload_sessions" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_provider_upload_uq" ON "upload_sessions" USING btree ("provider_upload_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_manifest_digest_uq" ON "upload_sessions" USING btree ("manifest_digest") WHERE "upload_sessions"."manifest_digest" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wrapping_materials_attempt_object_uq" ON "wrapping_materials" USING btree ("attempt_id","object_id");