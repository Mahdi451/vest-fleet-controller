import { z } from 'zod';

export const checkIds = [
  'security',
  'build',
  'typecheck',
  'lint',
  'format',
  'regression',
] as const;
const gateSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/),
    title: z.string().min(1),
    phase: z.enum(['OFFLINE', 'VEST_EVIDENCE', 'HUMAN', 'AUTHORIZED_LIVE']),
    automation: z.enum(['LOCAL', 'BROWSER', 'HUMAN', 'LIVE']),
    checks: z.array(z.enum(checkIds)),
    requires: z.array(z.string()),
  })
  .strict();
const catalogSchema = z
  .object({
    version: z.literal(1),
    goal: z.string().min(1),
    gates: z.array(gateSchema).min(1),
  })
  .strict();
export type Catalog = z.infer<typeof catalogSchema>;
export type CheckResult = {
  id: (typeof checkIds)[number];
  exit: 0 | 1;
  durationMs: number;
};

export function validateCatalog(input: unknown): Catalog {
  const catalog = catalogSchema.parse(input);
  const gates = new Map(catalog.gates.map((gate) => [gate.id, gate]));
  if (gates.size !== catalog.gates.length) throw new Error('DUPLICATE_GATE');
  const automation = {
    OFFLINE: 'LOCAL',
    VEST_EVIDENCE: 'BROWSER',
    HUMAN: 'HUMAN',
    AUTHORIZED_LIVE: 'LIVE',
  };
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    const gate = gates.get(id);
    if (!gate) throw new Error('UNKNOWN_PREREQUISITE');
    if (visiting.has(id)) throw new Error('CYCLIC_PREREQUISITES');
    if (visited.has(id)) return;
    if (
      automation[gate.phase] !== gate.automation ||
      (gate.phase !== 'OFFLINE' && gate.checks.length)
    )
      throw new Error('INVALID_GATE_AUTOMATION');
    if (
      new Set(gate.checks).size !== gate.checks.length ||
      new Set(gate.requires).size !== gate.requires.length
    )
      throw new Error('DUPLICATE_GATE_REQUIREMENT');
    visiting.add(id);
    gate.requires.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  catalog.gates.forEach((gate) => visit(gate.id));
  return catalog;
}

export function createVerificationReport(
  input: unknown,
  results: CheckResult[],
  before: string,
  after: string,
) {
  const catalog = validateCatalog(input);
  const validated = z
    .array(
      z
        .object({
          id: z.enum(checkIds),
          exit: z.union([z.literal(0), z.literal(1)]),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
    )
    .parse(results);
  if (new Set(validated.map((check) => check.id)).size !== validated.length)
    throw new Error('DUPLICATE_CHECK');
  const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
  fingerprint.parse(before);
  fingerprint.parse(after);
  const stale = before !== after;
  type Status =
    | 'PASS'
    | 'FAIL'
    | 'UNPROVEN'
    | 'BLOCKED'
    | 'STALE'
    | 'REVIEW_REQUIRED'
    | 'AUTHORIZATION_REQUIRED';
  const statuses = new Map<string, Status>();
  function status(id: string): Status {
    const previous = statuses.get(id);
    if (previous) return previous;
    const gate = catalog.gates.find((candidate) => candidate.id === id)!;
    let result: Status;
    if (gate.phase !== 'OFFLINE')
      result =
        gate.phase === 'HUMAN'
          ? 'REVIEW_REQUIRED'
          : gate.phase === 'AUTHORIZED_LIVE'
            ? 'AUTHORIZATION_REQUIRED'
            : 'UNPROVEN';
    else if (stale) result = 'STALE';
    else if (!gate.checks.length) result = 'UNPROVEN';
    else if (
      gate.checks.some(
        (check) => validated.find((record) => record.id === check)?.exit === 1,
      )
    )
      result = 'FAIL';
    else if (
      gate.checks.some(
        (check) => !validated.some((record) => record.id === check),
      )
    )
      result = 'UNPROVEN';
    else if (gate.requires.some((required) => status(required) !== 'PASS'))
      result = 'BLOCKED';
    else result = 'PASS';
    statuses.set(id, result);
    return result;
  }
  const gates = catalog.gates.map((gate) => ({
    id: gate.id,
    phase: gate.phase,
    status: status(gate.id),
  }));
  return {
    version: 1,
    goal: catalog.goal,
    liveState: 'LOCKED',
    functional: false,
    authorizesLive: false,
    stale,
    sourceFingerprintBefore: before,
    sourceFingerprintAfter: after,
    checks: validated,
    gates,
    localChecksPassed:
      !stale &&
      checkIds.every((id) =>
        validated.some((check) => check.id === id && check.exit === 0),
      ),
    offlineGatesComplete: gates
      .filter((gate) => gate.phase === 'OFFLINE')
      .every((gate) => gate.status === 'PASS'),
  } as const;
}
