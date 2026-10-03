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

/** Keep every exact leverage the ticket showed. Ignore nearby labels such as "Change to 1x". */
export function leverageChoices(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const label of labels) {
    const match = String(label)
      .replace(/\s+/g, ' ')
      .trim()
      .match(/^(?:(\d+(?:\.\d+)?)x|(\d+(?:\.\d+)?))$/i);
    const raw = match?.[1] ?? match?.[2];
    if (!raw) continue;
    const number = Number(raw);
    if (!Number.isFinite(number) || number <= 0) continue;
    const canonical = String(number);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    choices.push(canonical);
  }
  return choices;
}

const ticketSchema = z
  .object({
    market,
    leverageLabels: z.array(z.string().max(40)).max(40),
    marketClosed: z.boolean(),
  })
  .strict();
export type VestTicketLeverage = {
  market: string;
  choices: string[];
  marketClosed: boolean;
};

/** The open page is the only leverage menu. This stores that read; it never clicks. */
export function observeVestTicket(input: unknown): VestTicketLeverage {
  const ticket = ticketSchema.parse(input);
  return {
    market: ticket.market,
    choices: leverageChoices(ticket.leverageLabels),
    marketClosed: ticket.marketClosed,
  };
}
const vestPercent = z
  .string()
  .regex(/^\d{1,3}(?:\.\d+)?$/)
  .refine((value) => {
    const number = Number(value);
    return number > 0 && number <= 100;
  }, 'PERCENT_OUT_OF_RANGE');
const copyPlanSchema = z
  .object({
    action: z.enum(['LONG', 'SHORT', 'FLATTEN']),
    market,
    accountLabels: z.array(accountLabel).min(1).max(10),
    leverage: z.string().min(1).max(16),
    offeredLeverage: z.array(z.string().max(40)).max(40),
    percent: vestPercent,
    stopDistance: positive.optional(),
    targetDistance: positive.optional(),
    account01Flat: z.boolean(),
    scope: z.enum(['NEXT_ACCOUNT', 'SELECTION']).default('NEXT_ACCOUNT'),
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
export type SequentialCopyPlan = {
  simultaneous: false;
  liveSend: false;
  clicksOrderControls: false;
  blockedReason: string | null;
  steps: Array<{
    order: number;
    market: string;
    accountLabel: string;
    action: 'LONG' | 'SHORT' | 'FLATTEN';
    leverage: string;
    percent: string;
    stopDistance: string | null;
    targetDistance: string | null;
    waitForProtection: boolean;
  }>;
};

function copyBlockReason(
  command: z.infer<typeof copyPlanSchema>,
  choices: readonly string[],
): string | null {
  if (command.action !== 'FLATTEN') {
    const selected = leverageChoices([command.leverage])[0] ?? null;
    if (choices.length === 0) return 'LEVERAGE_UNOBSERVED';
    if (!selected || !choices.includes(selected)) return 'LEVERAGE_NOT_OFFERED';
  }
  if (command.scope === 'SELECTION') {
    if (command.action !== 'FLATTEN' && !command.account01Flat)
      return 'ACCOUNT_01_NOT_FLAT';
    return null;
  }
  if (command.action === 'FLATTEN') {
    if (
      command.accountLabels.length !== 1 ||
      command.accountLabels[0] !== 'Account 01'
    )
      return 'FLATTEN_TEST_IS_ACCOUNT_01';
    return null;
  }
  if (!command.account01Flat) return 'ACCOUNT_01_NOT_FLAT';
  if (
    command.accountLabels.length !== 1 ||
    command.accountLabels[0] !== 'Account 02'
  )
    return 'FIRST_COPY_IS_ACCOUNT_02';
  return null;
}

/** One watched account at a time. This describes the copy; it never clicks Vest. */
export function planSequentialCopy(input: unknown): SequentialCopyPlan {
  const command = copyPlanSchema.parse(input);
  if (new Set(command.accountLabels).size !== command.accountLabels.length)
    throw new Error('DUPLICATE_ACCOUNT');
  const choices = leverageChoices(command.offeredLeverage);
  const selected = leverageChoices([command.leverage])[0] ?? command.leverage;
  const blockedReason = copyBlockReason(
    { ...command, leverage: selected },
    choices,
  );
  return {
    simultaneous: false,
    liveSend: false,
    clicksOrderControls: false,
    blockedReason,
    steps: blockedReason
      ? []
      : command.accountLabels.map((accountLabel, index) => ({
          order: index + 1,
          market: command.market,
          accountLabel,
          action: command.action,
          leverage: selected,
          percent: command.percent,
          stopDistance: command.stopDistance ?? null,
          targetDistance: command.targetDistance ?? null,
          waitForProtection: command.action !== 'FLATTEN',
        })),
  };
}
