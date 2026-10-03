import type { ExecutionPhase } from './contract.ts';

const next = {
  PREVIEWED: ['ACCOUNT_VERIFYING', 'HALTED'],
  ACCOUNT_VERIFYING: ['TICKET_VERIFYING', 'HALTED'],
  TICKET_VERIFYING: ['ENTRY_READY', 'HALTED'],
  ENTRY_READY: ['ENTRY_SUBMITTING', 'HALTED'],
  ENTRY_SUBMITTING: [
    'ENTRY_FILLED',
    'ENTRY_UNKNOWN',
    'ENTRY_FILLED_UNPROTECTED',
    'HALTED',
  ],
  ENTRY_UNKNOWN: ['ENTRY_FILLED', 'ENTRY_FILLED_UNPROTECTED', 'HALTED'],
  ENTRY_FILLED: ['PROTECTION_SUBMITTING', 'ENTRY_FILLED_UNPROTECTED', 'HALTED'],
  ENTRY_FILLED_UNPROTECTED: ['PROTECTION_SUBMITTING', 'HALTED'],
  PROTECTION_SUBMITTING: ['PROTECTED', 'HALTED'],
  PROTECTED: ['VERIFIED', 'HALTED'],
  VERIFIED: [],
  HALTED: [],
} as const satisfies Record<ExecutionPhase, readonly ExecutionPhase[]>;

export function canTransition(
  from: ExecutionPhase,
  to: ExecutionPhase,
): boolean {
  return (next[from] as readonly ExecutionPhase[]).includes(to);
}

/** ENTRY_UNKNOWN reconciles. It never submits again. */
export function transition(
  from: ExecutionPhase,
  to: ExecutionPhase,
): ExecutionPhase {
  if (from === 'ENTRY_UNKNOWN' && to === 'ENTRY_SUBMITTING')
    throw new Error('ENTRY_UNKNOWN_CANNOT_RESUBMIT');
  if (!canTransition(from, to)) throw new Error('ILLEGAL_PHASE');
  return to;
}
