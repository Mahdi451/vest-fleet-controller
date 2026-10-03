import { expect, it } from 'vitest';
import { LIVE_VEST_SEND } from '../packages/browser-execution/src/live-command.ts';
import {
  customerReleaseStatus,
  decideOneAccountDriver,
  unobservedFleetReview,
  type FleetCapabilityReview,
} from '../packages/browser-execution/src/capability.ts';

function proven(): FleetCapabilityReview {
  return {
    ...unobservedFleetReview(),
    accountCount: 10,
    expectedAccountCount: 10,
    identityStableAcrossViews: true,
    selectionSerialized: true,
    fillCorrelationProven: true,
    independentStopAndTarget: true,
    protectionPersistsWithoutBrowser: true,
    closeProvenFlat: true,
    executionTerms: 'ALLOWED',
    commercialDistribution: 'UNRESOLVED',
    chartLayoutAfterRelaunch: 'KEPT',
  };
}

it('keeps the current fleet at no-go while every field is unobserved', () => {
  const decision = decideOneAccountDriver(unobservedFleetReview());
  expect(decision.decision).toBe('NO_GO');
  expect(decision.liveSend).toBe(false);
  expect(decision.chartLayoutAfterRelaunch).toBe('UNOBSERVED');
  expect(decision.commercialDistribution).toBe('UNRESOLVED');
  expect(decision.blockers).toEqual([
    'ACCOUNT_COUNT_UNOBSERVED',
    'IDENTITY_UNOBSERVED',
    'SELECTION_UNOBSERVED',
    'FILL_CORRELATION_UNOBSERVED',
    'STOP_AND_TARGET_UNOBSERVED',
    'PROTECTION_PERSISTENCE_UNOBSERVED',
    'CLOSE_UNOBSERVED',
    'EXECUTION_TERMS_UNRESOLVED',
  ]);
  expect(LIVE_VEST_SEND).toBe(false);
});

it('records a chart reset without treating it as an order blocker', () => {
  const decision = decideOneAccountDriver({
    ...proven(),
    chartLayoutAfterRelaunch: 'RESET',
  });
  expect(decision.decision).toBe('GO');
  expect(decision.chartLayoutAfterRelaunch).toBe('RESET');
  expect(decision.liveSend).toBe(false);
});

it('stays no-go when a required proof is false or the account count differs', () => {
  expect(
    decideOneAccountDriver({
      ...proven(),
      protectionPersistsWithoutBrowser: false,
    }).blockers,
  ).toContain('PROTECTION_PERSISTENCE_UNPROVEN');
  expect(
    decideOneAccountDriver({ ...proven(), accountCount: 9 }).decision,
  ).toBe('NO_GO');
  expect(
    decideOneAccountDriver({ ...proven(), executionTerms: 'DENIED' }).blockers,
  ).toContain('EXECUTION_TERMS_DENIED');
});

it('limits the scope to inventory when terms allow it and order evidence is unseen', () => {
  const decision = decideOneAccountDriver({
    ...proven(),
    fillCorrelationProven: null,
    independentStopAndTarget: null,
    protectionPersistsWithoutBrowser: null,
    closeProvenFlat: null,
    commercialDistribution: 'ALLOWED',
  });
  expect(decision.decision).toBe('LIMITED_SCOPE');
  expect(decision.liveSend).toBe(false);
  expect(decision.commercialDistribution).toBe('ALLOWED');
});

it('does not open customer packaging from installers or an unfinished driver', () => {
  expect(
    customerReleaseStatus({
      driverDecision: 'NO_GO',
      phoneAcceptance: true,
      hostSleepReboot: true,
      signedInstallers: true,
    }),
  ).toMatchObject({
    packagingUnblocked: false,
    liveSend: false,
    parked: ['ONE_ACCOUNT_DRIVER'],
  });
  expect(
    customerReleaseStatus({
      driverDecision: 'GO',
      phoneAcceptance: false,
      hostSleepReboot: false,
      signedInstallers: false,
    }).parked,
  ).toEqual(['PHONE_ACCEPTANCE', 'HOST_SLEEP_REBOOT', 'SIGNED_INSTALLERS']);
  expect(
    customerReleaseStatus({
      driverDecision: 'GO',
      phoneAcceptance: true,
      hostSleepReboot: true,
      signedInstallers: true,
    }),
  ).toMatchObject({ packagingUnblocked: true, liveSend: false, parked: [] });
});
