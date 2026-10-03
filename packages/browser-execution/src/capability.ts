import { z } from 'zod';

/** Evidence review for a future one-account driver. It never places an order. */
const reviewSchema = z
  .object({
    accountCount: z.number().int().positive().nullable(),
    expectedAccountCount: z.number().int().positive().nullable(),
    identityStableAcrossViews: z.boolean().nullable(),
    selectionSerialized: z.boolean().nullable(),
    fillCorrelationProven: z.boolean().nullable(),
    independentStopAndTarget: z.boolean().nullable(),
    protectionPersistsWithoutBrowser: z.boolean().nullable(),
    closeProvenFlat: z.boolean().nullable(),
    executionTerms: z.enum(['UNRESOLVED', 'ALLOWED', 'DENIED']),
    commercialDistribution: z.enum(['UNRESOLVED', 'ALLOWED', 'DENIED']),
    chartLayoutAfterRelaunch: z.enum(['UNOBSERVED', 'KEPT', 'RESET']),
  })
  .strict();
export type FleetCapabilityReview = z.infer<typeof reviewSchema>;
export type CapabilityDecision = 'NO_GO' | 'LIMITED_SCOPE' | 'GO';
const proof = [
  ['identityStableAcrossViews', 'IDENTITY'],
  ['selectionSerialized', 'SELECTION'],
  ['fillCorrelationProven', 'FILL_CORRELATION'],
  ['independentStopAndTarget', 'STOP_AND_TARGET'],
  ['protectionPersistsWithoutBrowser', 'PROTECTION_PERSISTENCE'],
  ['closeProvenFlat', 'CLOSE'],
] as const;

/** The fleet has not been inspected. Nulls stay unknown; nothing is filled in. */
export function unobservedFleetReview(): FleetCapabilityReview {
  return reviewSchema.parse({
    accountCount: null,
    expectedAccountCount: null,
    identityStableAcrossViews: null,
    selectionSerialized: null,
    fillCorrelationProven: null,
    independentStopAndTarget: null,
    protectionPersistsWithoutBrowser: null,
    closeProvenFlat: null,
    executionTerms: 'UNRESOLVED',
    commercialDistribution: 'UNRESOLVED',
    chartLayoutAfterRelaunch: 'UNOBSERVED',
  });
}

export function decideOneAccountDriver(input: unknown): {
  decision: CapabilityDecision;
  liveSend: false;
  blockers: string[];
  commercialDistribution: FleetCapabilityReview['commercialDistribution'];
  chartLayoutAfterRelaunch: FleetCapabilityReview['chartLayoutAfterRelaunch'];
} {
  const review = reviewSchema.parse(input);
  const blockers: string[] = [];
  if (review.accountCount === null || review.expectedAccountCount === null)
    blockers.push('ACCOUNT_COUNT_UNOBSERVED');
  else if (review.accountCount !== review.expectedAccountCount)
    blockers.push('ACCOUNT_COUNT_MISMATCH');
  for (const [field, code] of proof) {
    if (review[field] === null) blockers.push(`${code}_UNOBSERVED`);
    else if (review[field] === false) blockers.push(`${code}_UNPROVEN`);
  }
  if (review.executionTerms === 'UNRESOLVED')
    blockers.push('EXECUTION_TERMS_UNRESOLVED');
  if (review.executionTerms === 'DENIED')
    blockers.push('EXECUTION_TERMS_DENIED');
  const inventoryProven =
    review.accountCount !== null &&
    review.accountCount === review.expectedAccountCount &&
    review.identityStableAcrossViews === true &&
    review.selectionSerialized === true;
  const tradingUnobserved = [
    review.fillCorrelationProven,
    review.independentStopAndTarget,
    review.protectionPersistsWithoutBrowser,
    review.closeProvenFlat,
  ].every((value) => value === null);
  const decision: CapabilityDecision =
    blockers.length === 0
      ? 'GO'
      : review.executionTerms === 'ALLOWED' &&
          inventoryProven &&
          tradingUnobserved
        ? 'LIMITED_SCOPE'
        : 'NO_GO';
  return {
    decision,
    liveSend: false,
    blockers,
    commercialDistribution: review.commercialDistribution,
    chartLayoutAfterRelaunch: review.chartLayoutAfterRelaunch,
  };
}

/** Customer packaging stays closed until the driver decision and these checks pass. */
export function customerReleaseStatus(checks: {
  driverDecision: CapabilityDecision;
  phoneAcceptance: boolean;
  hostSleepReboot: boolean;
  signedInstallers: boolean;
}) {
  const parked = [
    checks.phoneAcceptance ? null : 'PHONE_ACCEPTANCE',
    checks.hostSleepReboot ? null : 'HOST_SLEEP_REBOOT',
    checks.signedInstallers ? null : 'SIGNED_INSTALLERS',
  ].filter((item): item is string => item !== null);
  if (checks.driverDecision !== 'GO') parked.unshift('ONE_ACCOUNT_DRIVER');
  return {
    packagingUnblocked: parked.length === 0,
    liveSend: false as const,
    parked,
  };
}
