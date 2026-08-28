import type { Pool } from "pg";
import { z } from "zod";

const GithubUsernameSchema = z
  .string()
  .trim()
  .max(40)
  .transform((value) =>
    (value.startsWith("@") ? value.slice(1) : value).toLowerCase(),
  )
  .pipe(
    z
      .string()
      .min(1)
      .max(39)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u)
      .refine((value) => !value.includes("--")),
  );

export const ClosedBetaSignupInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(3)
      .max(254)
      .email()
      .transform((value) => value.toLowerCase()),
    githubUsername: GithubUsernameSchema,
    contactConsent: z.literal(true),
    website: z.string().trim().max(200).default(""),
  })
  .strict();

export type ClosedBetaSignupInput = z.output<
  typeof ClosedBetaSignupInputSchema
>;

export type ClosedBetaSignupPersistence = Readonly<{
  accepted: true;
  stored: boolean;
}>;

/**
 * Stores only explicit beta-contact consent and the two coordinates needed to
 * admit the account later. A duplicate or a filled honeypot is deliberately
 * indistinguishable to the public caller.
 */
export async function persistClosedBetaSignup(
  pool: Pick<Pool, "query">,
  rawInput: unknown,
): Promise<ClosedBetaSignupPersistence> {
  const input = ClosedBetaSignupInputSchema.parse(rawInput);
  if (input.website.length > 0) {
    return { accepted: true, stored: false };
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO closed_beta_signups
       (email, github_username, contact_consent_version)
     VALUES ($1, $2, 'closed-beta-v1')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.email, input.githubUsername],
  );

  return { accepted: true, stored: inserted.rowCount === 1 };
}
