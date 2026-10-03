import { D } from '../../../core/src/index.ts';
import { evaluateFleetExposure } from '../../../risk-engine/src/exposure.ts';
import type {
  AccountEvidence,
  AccountPositionState,
  CopierExecutionAdapter,
  EntryCommand,
  ExecutionPhase,
  ObservedPosition,
} from './contract.ts';
import type {
  AccountJournalEntry,
  CopyRunRecord,
  JournalCheck,
} from './journal.ts';
import { CopyRunJournal } from './journal.ts';
import { transition } from './machine.ts';

export interface CopyRunRequest {
  readonly runId: number;
  readonly accounts: readonly string[];
  readonly symbol: string;
  readonly side: EntryCommand['side'];
  readonly leverage: string;
  readonly allocation: string;
  readonly orderValueCap: string;
  readonly adapter: CopierExecutionAdapter;
}

function commandFor(
  request: CopyRunRequest,
  accountLabel: string,
): EntryCommand {
  return {
    accountLabel,
    symbol: request.symbol,
    side: request.side,
    leverage: request.leverage,
    allocation: request.allocation,
    orderValueCap: request.orderValueCap,
  };
}

function orderValueAllowed(value: string | null, cap: string): boolean {
  if (!value) return false;
  try {
    const amount = new D(value);
    return amount.gt(0) && amount.lte(cap);
  } catch {
    return false;
  }
}

function protectedFacts(evidence: AccountEvidence): boolean {
  return (
    evidence.positionState === 'OPEN_PROTECTED' &&
    evidence.fill !== null &&
    evidence.stop?.reduceOnly === true &&
    evidence.target?.reduceOnly === true
  );
}

function halt(
  phase: ExecutionPhase,
  reason: string,
  checks: JournalCheck[],
  positionState: AccountPositionState,
): Pick<
  AccountJournalEntry,
  'status' | 'failureReason' | 'phase' | 'positionState' | 'checks'
> {
  return {
    status: 'FAILED',
    failureReason: reason,
    phase: transition(phase, 'HALTED'),
    positionState: positionState === 'UNKNOWN' ? 'HALTED' : positionState,
    checks,
  };
}

async function executeAccount(
  request: CopyRunRequest,
  accountLabel: string,
  prior: readonly AccountJournalEntry[],
): Promise<AccountJournalEntry> {
  const command = commandFor(request, accountLabel);
  const checks: JournalCheck[] = [];
  let phase: ExecutionPhase = 'PREVIEWED';
  let submitted = false;
  const fail = (
    reason: string,
    positionState: AccountPositionState = 'HALTED',
  ) => ({
    accountLabel,
    ...halt(phase, reason, checks, positionState),
  });
  try {
    phase = transition(phase, 'ACCOUNT_VERIFYING');
    let evidence = await request.adapter.inspect(accountLabel, command);
    const accountOk = evidence.observedAccount === accountLabel;
    checks.push({
      ok: accountOk,
      name: 'account',
      detail: accountOk
        ? 'expected account verified'
        : `expected ${accountLabel}`,
    });
    if (!accountOk) {
      checks.push({
        ok: false,
        name: 'observed-account',
        detail: `observed ${evidence.observedAccount ?? 'none'}`,
      });
      return fail('FAILED_WRONG_HEADER', 'HALTED');
    }
    if (evidence.session !== 'AUTHENTICATED') return fail('LOGIN_LOSS');
    if (evidence.pagesOpen !== 1 || !evidence.ticketFresh)
      return fail('STALE_BROWSER');
    if (evidence.positionState === 'UNKNOWN')
      return fail('UNSAFE_STATE', 'UNKNOWN');
    if (
      evidence.positionState === 'OPEN_PROTECTED' ||
      evidence.positionState === 'OPEN_UNPROTECTED'
    )
      return fail('EXISTING_POSITION', evidence.positionState);
    if (
      evidence.positionState !== 'FLAT' &&
      evidence.positionState !== 'CONFIRMED_FLAT'
    )
      return fail('UNSAFE_STATE', evidence.positionState);

    phase = transition(phase, 'TICKET_VERIFYING');
    const symbolOk =
      evidence.symbol === request.symbol && !evidence.marketClosed;
    checks.push({
      ok: symbolOk,
      name: 'symbol',
      detail: symbolOk
        ? `symbol ${request.symbol}`
        : `symbol ${evidence.symbol ?? 'none'}`,
    });
    if (!symbolOk)
      return fail(evidence.marketClosed ? 'MARKET_CLOSED' : 'SYMBOL_MISMATCH');
    const leverageOk = evidence.observedLeverage === request.leverage;
    checks.push({
      ok: leverageOk,
      name: 'leverage',
      detail: leverageOk
        ? `leverage ${request.leverage}x`
        : `leverage observed ${evidence.observedLeverage ?? 'none'}`,
    });
    if (!leverageOk) return fail('LEVERAGE_NOT_CONFIRMED');
    const sizeOk =
      evidence.observedAllocation === request.allocation &&
      orderValueAllowed(evidence.observedOrderValue, request.orderValueCap);
    checks.push({
      ok: sizeOk,
      name: 'allocation',
      detail: sizeOk
        ? `allocation ${request.allocation}%`
        : `allocation observed ${evidence.observedAllocation ?? 'none'}`,
    });
    if (!sizeOk) return fail('SIZE_NOT_CONFIRMED');

    const observed: ObservedPosition[] = [
      ...evidence.otherEnabledPositions,
      ...prior
        .filter(
          (entry) =>
            entry.status === 'VERIFIED' &&
            entry.positionState === 'OPEN_PROTECTED',
        )
        .map((entry) => ({
          accountLabel: entry.accountLabel,
          symbol: request.symbol,
          side: request.side,
          quantity: '1',
          enabled: true,
        })),
    ];
    const hedge = evaluateFleetExposure(
      { symbol: request.symbol, side: request.side },
      observed.map((position) => ({
        accountId: position.accountLabel,
        enabled: position.enabled,
        positions: [
          {
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
          },
        ],
      })),
    );
    if (hedge.length > 0) {
      checks.push({
        ok: false,
        name: 'hedge',
        detail: 'opposing fleet direction',
      });
      return fail('HEDGE_GUARD');
    }

    phase = transition(phase, 'ENTRY_READY');
    phase = transition(phase, 'ENTRY_SUBMITTING');
    evidence = await request.adapter.submit(accountLabel, command);
    submitted = true;
    checks.push({ ok: true, name: 'entry', detail: 'entry submitted once' });
    if (evidence.entrySubmission === 'UNKNOWN') {
      phase = transition(phase, 'ENTRY_UNKNOWN');
      evidence = await request.adapter.reconcile(accountLabel, command);
      if (
        evidence.entrySubmission === 'UNKNOWN' ||
        evidence.positionState === 'UNKNOWN'
      )
        return fail('AMBIGUOUS_ENTRY', 'UNKNOWN');
    }
    if (evidence.entrySubmission === 'REJECTED' || evidence.failureReason)
      return fail(evidence.failureReason ?? 'ENTRY_REJECTED');
    if (!evidence.fill) return fail('FILL_UNCONFIRMED', evidence.positionState);
    checks.push({
      ok: true,
      name: 'fill',
      detail: 'actual fill recorded',
    });
    phase = transition(phase, 'ENTRY_FILLED');
    if (!evidence.stop || !evidence.target) {
      phase = transition(phase, 'ENTRY_FILLED_UNPROTECTED');
      phase = transition(phase, 'PROTECTION_SUBMITTING');
      evidence = await request.adapter.submitProtection(accountLabel, command);
    } else {
      phase = transition(phase, 'PROTECTION_SUBMITTING');
      evidence = await request.adapter.reconcile(accountLabel, command);
    }
    if (!evidence.stop?.reduceOnly) {
      checks.push({ ok: false, name: 'stop', detail: 'stop missing' });
      return fail('UNPROTECTED', 'OPEN_UNPROTECTED');
    }
    if (!evidence.target?.reduceOnly) {
      checks.push({ ok: false, name: 'target', detail: 'target missing' });
      return fail('UNPROTECTED', 'OPEN_UNPROTECTED');
    }
    checks.push({ ok: true, name: 'stop', detail: 'stop confirmed' });
    checks.push({ ok: true, name: 'target', detail: 'target confirmed' });
    phase = transition(phase, 'PROTECTED');
    evidence = await request.adapter.reconcile(accountLabel, command);
    if (!protectedFacts(evidence) || evidence.observedAccount !== accountLabel)
      return fail('VERIFICATION_FAILED', evidence.positionState);
    phase = transition(phase, 'VERIFIED');
    return {
      accountLabel,
      status: 'VERIFIED',
      failureReason: null,
      phase,
      positionState: 'OPEN_PROTECTED',
      checks,
    };
  } catch (error) {
    const reason =
      error instanceof Error &&
      error.message === 'ENTRY_UNKNOWN_CANNOT_RESUBMIT'
        ? 'DUPLICATE_SUBMIT'
        : 'ADAPTER_ERROR';
    if (submitted && reason === 'ADAPTER_ERROR') {
      checks.push({
        ok: false,
        name: 'entry',
        detail: 'entry outcome unknown',
      });
    }
    return {
      accountLabel,
      status: 'FAILED',
      failureReason: reason,
      phase: phase === 'HALTED' ? phase : 'HALTED',
      positionState: 'HALTED',
      checks,
    };
  }
}

/** One account at a time. A later account starts only after the previous one is verified. */
export async function runSequentialCopy(
  request: CopyRunRequest,
  journal: CopyRunJournal = new CopyRunJournal(),
): Promise<CopyRunRecord> {
  const accounts: AccountJournalEntry[] = [];
  let halted = false;
  let haltReason: string | null = null;
  for (const accountLabel of request.accounts) {
    if (halted) {
      accounts.push({
        accountLabel,
        status: 'NOT_ATTEMPTED',
        failureReason: null,
        phase: 'PREVIEWED',
        positionState: 'UNKNOWN',
        checks: [],
      });
      continue;
    }
    const result = await executeAccount(request, accountLabel, accounts);
    accounts.push(result);
    if (result.status !== 'VERIFIED') {
      halted = true;
      haltReason = result.failureReason;
    }
  }
  return journal.record({
    runId: request.runId,
    halted,
    haltReason,
    accounts,
  });
}
