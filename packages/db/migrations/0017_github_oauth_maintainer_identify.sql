ALTER TYPE github_oauth_purpose RENAME TO github_oauth_purpose_old;
CREATE TYPE github_oauth_purpose AS ENUM (
  'contributor_login',
  'maintainer_reauth',
  'maintainer_identify'
);
ALTER TABLE github_oauth_flows
  ALTER COLUMN purpose TYPE github_oauth_purpose
  USING purpose::text::github_oauth_purpose;
DROP TYPE github_oauth_purpose_old;

ALTER TABLE github_oauth_flows
  ALTER COLUMN repository_id DROP NOT NULL;

ALTER TABLE github_oauth_flows
  ADD CONSTRAINT github_oauth_flows_identify_binding CHECK (
    (purpose = 'maintainer_identify' AND repository_id IS NULL)
    OR (purpose <> 'maintainer_identify' AND repository_id IS NOT NULL)
  );
