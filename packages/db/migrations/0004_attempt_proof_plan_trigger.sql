DROP TRIGGER attempts_revision_binding ON attempts;

CREATE TRIGGER attempts_revision_binding
BEFORE INSERT OR UPDATE OF revision_id, repository_id, head_sha, proof_plan_id
ON attempts
FOR EACH ROW EXECUTE FUNCTION slopproof_guard_attempt_revision();
