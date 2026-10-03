import { z } from 'zod';
import { isFresh, positive } from '../../core/src/index.ts';

/** Live Vest clicks stay off until a separate one-account authorization. */
export const LIVE_VEST_SEND = false as const;

const market = z.string().regex(/^[A-Z0-9]{1,12}(?:-[A-Z0-9]{1,12}){0,3}$/);
const accountLabel = z.string().regex(/^Account (?:0[1-9]|10)$/);
const commandSchema = z
  .object({
    action: z.enum(['LONG', 'SHORT', 'FLATTEN']),
    market,
    accountLabel,
    size: positive,
    leverage: positive,
    stopDistance: positive.optional(),
    targetDistance: positive.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (command.action === 'FLATTEN') return;
    if (!command.stopDistance)
      context.addIssue({
        code: 'custom',
        path: ['stopDistance'],
        message: 'STOP_REQUIRED',
      });
    if (!command.targetDistance)
      context.addIssue({
        code: 'custom',
        path: ['targetDistance'],
        message: 'TARGET_REQUIRED',
      });
  });

export type CompanionCommand = z.infer<typeof commandSchema>;
export interface CompanionCommandPreview {
  action: CompanionCommand['action'];
  market: string;
  accountLabel: string;
  size: string;
  leverage: string;
  stopDistance: string | null;
  targetDistance: string | null;
  liveSend: false;
  clicksOrderControls: false;
}

/** Describes the command. It never clicks Buy, Sell, or Flatten. */
export function previewCompanionCommand(
  input: unknown,
): CompanionCommandPreview {
  const command = commandSchema.parse(input);
  return {
    action: command.action,
    market: command.market,
    accountLabel: command.accountLabel,
    size: command.size,
    leverage: command.leverage,
    stopDistance: command.stopDistance ?? null,
    targetDistance: command.targetDistance ?? null,
    liveSend: LIVE_VEST_SEND,
    clicksOrderControls: false,
  };
}

/** Refusal point for a future Vest click. There is no enable flag. */
export function sendCompanionCommand(): never {
  throw new Error('LIVE_SEND_DISABLED');
}

const readinessSchema = z
  .object({
    accountLabel,
    headerLabel: z.string().nullable(),
    session: z.enum(['AUTHENTICATED', 'LOGIN_REQUIRED', 'UNKNOWN']),
    observedAt: z.number().int().nonnegative(),
    hasOpenFill: z.boolean(),
    protectionProven: z.boolean(),
  })
  .strict();
export type AccountReadiness = z.infer<typeof readinessSchema>;
export type VisibleStop =
  'LOGIN_LOSS' | 'WRONG_ACCOUNT' | 'STALE_DATA' | 'UNPROVEN_PROTECTION';
export interface AccountReview {
  accountLabel: string;
  status: 'CLEAR' | VisibleStop | 'STOPPED_AFTER_HALT';
  stop: VisibleStop | null;
}

function stopFor(
  check: AccountReadiness,
  now: number,
  maxAgeMs: number,
): VisibleStop | null {
  if (check.session !== 'AUTHENTICATED') return 'LOGIN_LOSS';
  if (check.headerLabel !== check.accountLabel) return 'WRONG_ACCOUNT';
  if (!isFresh(check.observedAt, now, maxAgeMs)) return 'STALE_DATA';
  if (check.hasOpenFill && !check.protectionProven)
    return 'UNPROVEN_PROTECTION';
  return null;
}

/** The first failed account halts the rest. Later accounts stay visible as not attempted. */
export function reviewAccounts(
  checks: readonly unknown[],
  now: number,
  maxAgeMs: number,
): { halted: boolean; accounts: AccountReview[] } {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
    throw new Error('INVALID_OBSERVATION_BUDGET');
  const parsed = checks.map((check) => readinessSchema.parse(check));
  const accounts: AccountReview[] = [];
  let halted = false;
  for (const check of parsed) {
    if (halted) {
      accounts.push({
        accountLabel: check.accountLabel,
        status: 'STOPPED_AFTER_HALT',
        stop: null,
      });
      continue;
    }
    const stop = stopFor(check, now, maxAgeMs);
    if (stop) {
      halted = true;
      accounts.push({ accountLabel: check.accountLabel, status: stop, stop });
      continue;
    }
    accounts.push({
      accountLabel: check.accountLabel,
      status: 'CLEAR',
      stop: null,
    });
  }
  return { halted, accounts };
}
