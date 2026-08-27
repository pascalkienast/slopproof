DO $$ BEGIN
 CREATE TYPE "closed_beta_signup_status" AS ENUM(
   'pending',
   'contacted',
   'admitted',
   'declined',
   'withdrawn'
 );
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE "closed_beta_signups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "github_username" text NOT NULL,
  "github_account_id" text,
  "status" "closed_beta_signup_status" NOT NULL DEFAULT 'pending',
  "contact_consent_version" text NOT NULL DEFAULT 'closed-beta-v1',
  "contact_consent_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "closed_beta_signups_email_format" CHECK (
    char_length("email") BETWEEN 3 AND 254
    AND "email" = lower(btrim("email"))
    AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  CONSTRAINT "closed_beta_signups_github_username_format" CHECK (
    "github_username" ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'
    AND position('--' in "github_username") = 0
  ),
  CONSTRAINT "closed_beta_signups_github_account_id_format" CHECK (
    "github_account_id" IS NULL
    OR "github_account_id" ~ '^[1-9][0-9]{0,15}$'
  ),
  CONSTRAINT "closed_beta_signups_consent_version" CHECK (
    "contact_consent_version" = 'closed-beta-v1'
  ),
  CONSTRAINT "closed_beta_signups_decision_state" CHECK (
    (
      "status" IN ('pending', 'contacted')
      AND "decided_at" IS NULL
    ) OR (
      "status" IN ('admitted', 'declined', 'withdrawn')
      AND "decided_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "closed_beta_signups_email_uq"
  ON "closed_beta_signups" (lower("email"));

CREATE UNIQUE INDEX "closed_beta_signups_github_username_uq"
  ON "closed_beta_signups" (lower("github_username"));

CREATE INDEX "closed_beta_signups_queue_idx"
  ON "closed_beta_signups" ("status", "created_at", "id");

ALTER TABLE "web_request_rate_limits"
  DROP CONSTRAINT "web_request_rate_limits_action_v1";

ALTER TABLE "web_request_rate_limits"
  ADD CONSTRAINT "web_request_rate_limits_action_v2" CHECK (
    "action" IN (
      'closed_beta_signup',
      'handoff_create',
      'handoff_exchange',
      'upload_start',
      'upload_part_url',
      'upload_part_complete',
      'upload_finalize',
      'review_queue',
      'review_detail',
      'review_context',
      'evidence_capability',
      'evidence_stream',
      'review_decision'
    )
  ) NOT VALID;

ALTER TABLE "web_request_rate_limits"
  VALIDATE CONSTRAINT "web_request_rate_limits_action_v2";
