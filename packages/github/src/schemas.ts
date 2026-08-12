import { GithubWebhookIngestPrJobSchema } from "@slopproof/db";
import { z } from "zod";

export const PullRequestActionSchema = z.enum([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "closed",
]);

const githubNumericIdSchema = z
  .union([
    z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    z.number().int().positive().safe(),
  ])
  .transform(String);

const userSchema = z.object({
  id: githubNumericIdSchema,
  login: z.string().min(1),
});
const repositorySchema = z.object({
  id: githubNumericIdSchema,
  name: z.string().min(1),
  full_name: z.string().min(3),
  default_branch: z.string().min(1),
  owner: z.object({
    id: githubNumericIdSchema,
    login: z.string().min(1),
  }),
});

const installationAccountSchema = z
  .object({
    id: githubNumericIdSchema,
    login: z.string().trim().min(1).max(100),
  })
  .passthrough();

const installationSchema = z
  .object({
    id: githubNumericIdSchema,
    account: installationAccountSchema,
  })
  .passthrough();

const lifecycleRepositorySchema = z
  .object({
    id: githubNumericIdSchema,
    name: z.string().trim().min(1).max(100),
    full_name: z.string().trim().min(3).max(201),
    default_branch: z.string().trim().min(1).max(255).nullable().optional(),
  })
  .passthrough()
  .transform((repository) => {
    const [owner, name, ...rest] = repository.full_name.split("/");
    if (!owner || !name || rest.length > 0 || name !== repository.name) {
      throw new Error("Repository full_name is inconsistent");
    }
    return {
      githubRepositoryId: repository.id,
      owner,
      name,
      defaultBranch: repository.default_branch ?? null,
    };
  });

export const GithubPullRequestWebhookSchema = z
  .object({
    action: PullRequestActionSchema,
    installation: z.object({ id: githubNumericIdSchema }),
    repository: repositorySchema,
    pull_request: z.object({
      id: githubNumericIdSchema,
      number: z.number().int().positive(),
      state: z.enum(["open", "closed"]),
      draft: z.boolean().optional(),
      user: userSchema,
      head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
      base: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    }),
  })
  .transform((payload) => {
    const [owner, name, ...rest] = payload.repository.full_name.split("/");
    if (
      !owner ||
      !name ||
      rest.length > 0 ||
      name !== payload.repository.name
    ) {
      throw new Error("Repository full_name is inconsistent");
    }
    return {
      action: payload.action,
      installation: {
        githubInstallationId: payload.installation.id,
        accountId: payload.repository.owner.id,
        accountLogin: payload.repository.owner.login,
      },
      repository: {
        githubRepositoryId: payload.repository.id,
        owner,
        name,
        defaultBranch: payload.repository.default_branch,
      },
      pullRequest: {
        githubPullRequestId: payload.pull_request.id,
        number: payload.pull_request.number,
        state: payload.pull_request.state,
        authorId: payload.pull_request.user.id,
        headSha: payload.pull_request.head.sha,
        baseSha: payload.pull_request.base.sha,
      },
    };
  });

export const GithubPullRequestActionEnvelopeSchema = z
  .object({ action: z.string().trim().min(1).max(100) })
  .passthrough();

export type PullRequestEvent = z.output<typeof GithubPullRequestWebhookSchema>;

export const GithubInstallationActionSchema = z.enum([
  "created",
  "deleted",
  "new_permissions_accepted",
  "suspend",
  "unsuspend",
]);

export const GithubInstallationRepositoriesActionSchema = z.enum([
  "added",
  "removed",
]);

export const GithubInstallationWebhookSchema = z
  .object({
    action: GithubInstallationActionSchema,
    installation: installationSchema,
    repositories: z.array(lifecycleRepositorySchema).max(1_000).optional(),
  })
  .passthrough()
  .transform((payload) => ({
    action: payload.action,
    installation: {
      githubInstallationId: payload.installation.id,
      accountId: payload.installation.account.id,
      accountLogin: payload.installation.account.login,
    },
    repositories: payload.repositories ?? [],
  }));

export type InstallationEvent = z.output<
  typeof GithubInstallationWebhookSchema
>;

export const GithubInstallationRepositoriesWebhookSchema = z
  .object({
    action: GithubInstallationRepositoriesActionSchema,
    installation: installationSchema,
    repositories_added: z.array(lifecycleRepositorySchema).max(1_000),
    repositories_removed: z.array(lifecycleRepositorySchema).max(1_000),
  })
  .passthrough()
  .transform((payload) => ({
    action: payload.action,
    installation: {
      githubInstallationId: payload.installation.id,
      accountId: payload.installation.account.id,
      accountLogin: payload.installation.account.login,
    },
    repositoriesAdded: payload.repositories_added,
    repositoriesRemoved: payload.repositories_removed,
  }));

export type InstallationRepositoriesEvent = z.output<
  typeof GithubInstallationRepositoriesWebhookSchema
>;

export const WebhookHeadersSchema = z
  .object({
    deliveryId: z.string().uuid(),
    eventName: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    signature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
  })
  .strict();

export type WebhookHeaders = z.infer<typeof WebhookHeadersSchema>;

export const PullRequestJobPayloadSchema = GithubWebhookIngestPrJobSchema;

export type PullRequestJobPayload = z.infer<typeof PullRequestJobPayloadSchema>;

export const PublicCheckInputSchema = z
  .object({
    revisionId: z.string().uuid(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z
      .enum(["action_required", "success", "neutral", "cancelled"])
      .nullable(),
    summary: z.string().min(1).max(500),
    detailsUrl: z.url(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.status === "completed" && input.conclusion === null) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "is required when completed",
      });
    }
    if (input.status !== "completed" && input.conclusion !== null) {
      context.addIssue({
        code: "custom",
        path: ["conclusion"],
        message: "must be null before completion",
      });
    }
  });

export type PublicCheckInput = z.infer<typeof PublicCheckInputSchema>;
