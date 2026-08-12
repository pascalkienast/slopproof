import { GithubIngestPrJobSchema } from "@slopproof/db";
import { z } from "zod";

export const PullRequestActionSchema = z.enum([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "closed",
]);

const userSchema = z.object({
  id: z.union([z.string(), z.number()]),
  login: z.string().min(1),
});
const repositorySchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().min(1),
  full_name: z.string().min(3),
  default_branch: z.string().min(1),
  owner: z.object({
    id: z.union([z.string(), z.number()]),
    login: z.string().min(1),
  }),
});

export const GithubPullRequestWebhookSchema = z
  .object({
    action: PullRequestActionSchema,
    installation: z.object({ id: z.union([z.string(), z.number()]) }),
    repository: repositorySchema,
    pull_request: z.object({
      id: z.union([z.string(), z.number()]),
      number: z.number().int().positive(),
      state: z.enum(["open", "closed"]),
      draft: z.boolean().optional(),
      user: userSchema,
      head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
      base: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    }),
  })
  .transform((payload) => {
    const [owner, name] = payload.repository.full_name.split("/", 2);
    if (!owner || !name || name !== payload.repository.name) {
      throw new Error("Repository full_name is inconsistent");
    }
    return {
      action: payload.action,
      installation: {
        githubInstallationId: String(payload.installation.id),
        accountId: String(payload.repository.owner.id),
        accountLogin: payload.repository.owner.login,
      },
      repository: {
        githubRepositoryId: String(payload.repository.id),
        owner,
        name,
        defaultBranch: payload.repository.default_branch,
      },
      pullRequest: {
        githubPullRequestId: String(payload.pull_request.id),
        number: payload.pull_request.number,
        state: payload.pull_request.state,
        authorId: String(payload.pull_request.user.id),
        headSha: payload.pull_request.head.sha,
        baseSha: payload.pull_request.base.sha,
      },
    };
  });

export type PullRequestEvent = z.output<typeof GithubPullRequestWebhookSchema>;

export const WebhookHeadersSchema = z
  .object({
    deliveryId: z.string().uuid(),
    eventName: z.literal("pull_request"),
    signature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
  })
  .strict();

export type WebhookHeaders = z.infer<typeof WebhookHeadersSchema>;

export const PullRequestJobPayloadSchema = GithubIngestPrJobSchema;

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
