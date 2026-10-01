import { z } from 'zod';

/** Owner authorization is not a claim of venue approval or permission to trade. */
export const observationAuthorizationSchema = z
  .object({
    ownerId: z.string().min(1),
    instanceId: z.string().min(1),
    reference: z.string().min(1),
    basis: z.enum(['USER_OWNER_AUTHORIZATION', 'VENUE_WRITTEN_APPROVAL']),
    termsReviewReference: z.string().min(1),
    scope: z.literal('READ_ONLY_OWNER_ACCOUNTS'),
    approvedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    revoked: z.boolean(),
  })
  .strict();
export type ObservationAuthorization = z.infer<
  typeof observationAuthorizationSchema
>;

export function assertObservationAuthorization(
  authorization: ObservationAuthorization | null,
  binding: { ownerId: string; instanceId: string },
  now: number,
) {
  if (
    !authorization ||
    authorization.revoked ||
    authorization.approvedAt > now ||
    authorization.expiresAt <= now
  )
    throw new Error('OBSERVATION_AUTHORIZATION_REQUIRED');
  if (
    authorization.ownerId !== binding.ownerId ||
    authorization.instanceId !== binding.instanceId
  )
    throw new Error('OBSERVATION_OWNER_MISMATCH');
}
