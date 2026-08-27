ALTER TYPE "github_lifecycle_status" ADD VALUE IF NOT EXISTS 'pending';

ALTER TABLE "installations" DROP CONSTRAINT "installations_lifecycle_timestamps";

ALTER TABLE "installations" ADD CONSTRAINT "installations_lifecycle_timestamps" CHECK ((
  (
    "status" IN ('active', 'pending')
    AND "suspended_at" IS NULL
    AND "removed_at" IS NULL
  ) OR (
    "status" = 'suspended'
    AND "suspended_at" IS NOT NULL
    AND "removed_at" IS NULL
  ) OR (
    "status" = 'removed'
    AND "removed_at" IS NOT NULL
  )
)) NOT VALID;

ALTER TABLE "installations" VALIDATE CONSTRAINT "installations_lifecycle_timestamps";

DO $$ BEGIN
 CREATE TYPE "github_app_allowlist_status" AS ENUM('active', 'inactive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "github_app_account_allowlist" (
  "github_account_id" text PRIMARY KEY,
  "status" "github_app_allowlist_status" NOT NULL DEFAULT 'active',
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "github_app_account_allowlist_github_account_id_format"
    CHECK ("github_account_id" ~ '^[1-9][0-9]{0,15}$')
);

CREATE INDEX IF NOT EXISTS "github_app_account_allowlist_active_idx"
  ON "github_app_account_allowlist" ("github_account_id")
  WHERE "status" = 'active';
