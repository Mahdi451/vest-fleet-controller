import { describe, expect, it } from 'vitest';
import {
  checkIds,
  createVerificationReport,
  validateCatalog,
  type CheckResult,
} from '../scripts/verification-report.ts';

const fingerprint = 'a'.repeat(64);
const passes: CheckResult[] = checkIds.map((id) => ({
  id,
  exit: 0,
  durationMs: 1,
}));
function catalog() {
  return {
    version: 1,
    goal: 'local proof',
    gates: [
      {
        id: 'foundation',
        title: 'Foundation',
        phase: 'OFFLINE',
        automation: 'LOCAL',
        checks: ['security', 'build'],
        requires: [],
      },
      {
        id: 'regression',
        title: 'Regression',
        phase: 'OFFLINE',
        automation: 'LOCAL',
        checks: ['regression'],
        requires: ['foundation'],
      },
      {
        id: 'arming',
        title: 'Arming pending',
        phase: 'OFFLINE',
        automation: 'LOCAL',
        checks: [],
        requires: ['foundation'],
      },
      {
        id: 'vest',
        title: 'Vest evidence',
        phase: 'VEST_EVIDENCE',
        automation: 'BROWSER',
        checks: [],
        requires: ['regression'],
      },
      {
        id: 'review',
        title: 'Owner review',
        phase: 'HUMAN',
        automation: 'HUMAN',
        checks: [],
        requires: ['vest'],
      },
      {
        id: 'live',
        title: 'Authorized live',
        phase: 'AUTHORIZED_LIVE',
        automation: 'LIVE',
        checks: [],
        requires: ['review'],
      },
    ],
  };
}
describe('local-only functional proof report', () => {
  it('never closes live/evidence/human gates from passing fixtures', () => {
    const report = createVerificationReport(
      catalog(),
      passes,
      fingerprint,
      fingerprint,
    );
    expect(report.gates.map((gate) => gate.status)).toEqual([
      'PASS',
      'PASS',
      'UNPROVEN',
      'UNPROVEN',
      'REVIEW_REQUIRED',
      'AUTHORIZATION_REQUIRED',
    ]);
    expect(report.functional).toBe(false);
    expect(report.authorizesLive).toBe(false);
    expect(report.liveState).toBe('LOCKED');
    expect(report.localChecksPassed).toBe(true);
    expect(report.offlineGatesComplete).toBe(false);
  });

  it('recognizes completed local checks without authorizing live', () => {
    const input = catalog();
    input.gates = input.gates.filter((gate) => gate.id !== 'arming');
    const report = createVerificationReport(
      input,
      passes,
      fingerprint,
      fingerprint,
    );
    expect(report.localChecksPassed).toBe(true);
    expect(report.functional).toBe(false);
  });

  it('marks failure and blocks dependent gates', () => {
    const results = passes.map((check) => ({
      ...check,
      exit: check.id === 'security' ? (1 as const) : check.exit,
    }));
    const report = createVerificationReport(
      catalog(),
      results,
      fingerprint,
      fingerprint,
    );
    expect(report.gates[0]?.status).toBe('FAIL');
    expect(report.gates[1]?.status).toBe('BLOCKED');
    expect(report.localChecksPassed).toBe(false);
  });

  it('missing checks cannot pass', () => {
    const report = createVerificationReport(
      catalog(),
      passes.filter((check) => check.id !== 'build'),
      fingerprint,
      fingerprint,
    );
    expect(report.gates[0]?.status).toBe('UNPROVEN');
    expect(report.localChecksPassed).toBe(false);
  });

  it('source changes invalidate offline results', () => {
    const report = createVerificationReport(
      catalog(),
      passes,
      fingerprint,
      'b'.repeat(64),
    );
    expect(report.stale).toBe(true);
    expect(
      report.gates
        .filter((gate) => gate.phase === 'OFFLINE')
        .every((gate) => gate.status === 'STALE'),
    ).toBe(true);
    expect(report.localChecksPassed).toBe(false);
  });

  it.each([
    'extra',
    'duplicate',
    'unknown-prerequisite',
    'cycle',
    'wrong-automation',
    'unknown-check',
    'browser-check',
  ])('rejects malformed catalog %s', (kind) => {
    const input = catalog();
    if (kind === 'extra') Object.assign(input, { command: 'external' });
    if (kind === 'duplicate') input.gates.push(input.gates[0]!);
    if (kind === 'unknown-prerequisite') input.gates[0]!.requires = ['missing'];
    if (kind === 'cycle') input.gates[0]!.requires = ['regression'];
    if (kind === 'wrong-automation') input.gates[0]!.automation = 'LIVE';
    if (kind === 'unknown-check') input.gates[0]!.checks = ['external'];
    if (kind === 'browser-check') input.gates[3]!.checks = ['regression'];
    expect(() => validateCatalog(input)).toThrow();
  });

  it('refuses duplicate, malformed, or secret-bearing result records', () => {
    expect(() =>
      createVerificationReport(
        catalog(),
        [...passes, passes[0]!],
        fingerprint,
        fingerprint,
      ),
    ).toThrow();
    expect(() =>
      createVerificationReport(
        catalog(),
        [{ ...passes[0]!, stdout: 'secret' }] as unknown as CheckResult[],
        fingerprint,
        fingerprint,
      ),
    ).toThrow();
    expect(() =>
      createVerificationReport(catalog(), passes, 'invalid', fingerprint),
    ).toThrow();
  });
});
