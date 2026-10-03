import type { AccountPositionState, ExecutionPhase } from './contract.ts';

export type AccountRunStatus = 'VERIFIED' | 'FAILED' | 'NOT_ATTEMPTED';

export interface JournalCheck {
  readonly ok: boolean;
  readonly name: string;
  readonly detail: string;
}

export interface AccountJournalEntry {
  readonly accountLabel: string;
  readonly status: AccountRunStatus;
  readonly failureReason: string | null;
  readonly phase: ExecutionPhase;
  readonly positionState: AccountPositionState;
  readonly checks: readonly JournalCheck[];
}

export interface CopyRunRecord {
  readonly runId: number;
  readonly halted: boolean;
  readonly haltReason: string | null;
  readonly accounts: readonly AccountJournalEntry[];
}

export class CopyRunJournal {
  private readonly runs: CopyRunRecord[] = [];
  constructor(private readonly sink?: (run: CopyRunRecord) => void) {}
  record(run: CopyRunRecord): CopyRunRecord {
    this.runs.push(run);
    this.sink?.(run);
    return run;
  }
  latest(): CopyRunRecord | null {
    return this.runs.at(-1) ?? null;
  }
  render(run: CopyRunRecord): string {
    const lines = [`COPY RUN #${run.runId}`, ''];
    for (const account of run.accounts) {
      lines.push(account.accountLabel);
      if (account.status === 'NOT_ATTEMPTED') {
        lines.push('NOT ATTEMPTED', '');
        continue;
      }
      for (const check of account.checks) {
        lines.push(`${check.ok ? '✓' : '✗'} ${check.detail}`);
      }
      lines.push(account.status === 'VERIFIED' ? '✓ PROTECTED' : 'HALTED', '');
    }
    return lines.join('\n').trimEnd();
  }
}
