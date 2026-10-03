import type {
  AccountEvidence,
  AccountPositionState,
  CopierExecutionAdapter,
  EntryCommand,
  EntrySubmission,
  ExitEvidence,
  FillEvidence,
} from './contract.ts';

export type MockScript =
  | { readonly kind: 'protected' }
  | { readonly kind: 'wrong-account'; readonly observed: string }
  | { readonly kind: 'stale-header' }
  | { readonly kind: 'leverage-mismatch'; readonly observed: string }
  | { readonly kind: 'size-rejected' }
  | { readonly kind: 'unknown-then-filled' }
  | { readonly kind: 'unknown-ambiguous' }
  | { readonly kind: 'missing-stop' }
  | { readonly kind: 'missing-target' }
  | { readonly kind: 'session-loss' }
  | { readonly kind: 'flatten-fails' }
  | {
      readonly kind: 'opposing-position';
      readonly symbol: string;
      readonly side: 'LONG' | 'SHORT';
      readonly enabled?: boolean;
    };

interface AccountSim {
  script: MockScript;
  submits: number;
  protectionSubmits: number;
  filled: boolean;
  ambiguous: boolean;
}

const stop = (price = '100'): ExitEvidence => ({ price, reduceOnly: true });
const target = (price = '110'): ExitEvidence => ({ price, reduceOnly: true });
const fill = (): FillEvidence => ({ price: '105', quantity: '1' });

function base(
  command: EntryCommand,
  patch: Partial<AccountEvidence> = {},
): AccountEvidence {
  return {
    expectedAccount: command.accountLabel,
    observedAccount: command.accountLabel,
    symbol: command.symbol,
    requestedLeverage: command.leverage,
    observedLeverage: command.leverage,
    requestedAllocation: command.allocation,
    observedAllocation: command.allocation,
    observedOrderValue: '8.49',
    entrySubmission: 'NONE',
    positionState: 'FLAT',
    fill: null,
    stop: null,
    target: null,
    pagesOpen: 1,
    session: 'AUTHENTICATED',
    marketClosed: false,
    ticketFresh: true,
    otherEnabledPositions: [],
    failureReason: null,
    ...patch,
  };
}

function protectedEvidence(command: EntryCommand): AccountEvidence {
  return base(command, {
    entrySubmission: 'CONFIRMED',
    positionState: 'OPEN_PROTECTED',
    fill: fill(),
    stop: stop(),
    target: target(),
  });
}

/** In-memory venue. A second submit is recorded and does not create another fill. */
export class MockCopierAdapter implements CopierExecutionAdapter {
  readonly name = 'MockCopierAdapter';
  readonly submits = new Map<string, number>();
  private readonly sims: Map<string, AccountSim>;
  constructor(scripts: Record<string, MockScript>) {
    this.sims = new Map(
      Object.entries(scripts).map(([account, script]) => [
        account,
        {
          script,
          submits: 0,
          protectionSubmits: 0,
          filled: false,
          ambiguous: false,
        },
      ]),
    );
  }
  submitCount(accountLabel: string): number {
    return this.submits.get(accountLabel) ?? 0;
  }
  async inspect(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence> {
    return this.view(accountLabel, command, false);
  }
  async submit(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence> {
    const sim = this.sim(accountLabel);
    sim.submits += 1;
    this.submits.set(accountLabel, sim.submits);
    if (sim.submits > 1) {
      return base(command, {
        entrySubmission: 'REJECTED',
        failureReason: 'DUPLICATE_SUBMIT',
        positionState: sim.filled ? 'OPEN_PROTECTED' : 'UNKNOWN',
      });
    }
    if (
      sim.script.kind === 'unknown-then-filled' ||
      sim.script.kind === 'unknown-ambiguous'
    ) {
      sim.ambiguous = sim.script.kind === 'unknown-ambiguous';
      sim.filled = sim.script.kind === 'unknown-then-filled';
      return base(command, {
        entrySubmission: 'UNKNOWN',
        positionState: 'UNKNOWN',
      });
    }
    if (
      sim.script.kind === 'missing-stop' ||
      sim.script.kind === 'missing-target'
    ) {
      sim.filled = true;
      return base(command, {
        entrySubmission: 'CONFIRMED',
        positionState: 'OPEN_UNPROTECTED',
        fill: fill(),
        stop: sim.script.kind === 'missing-stop' ? null : stop(),
        target: sim.script.kind === 'missing-target' ? null : target(),
      });
    }
    sim.filled = true;
    return protectedEvidence(command);
  }
  async submitProtection(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence> {
    const sim = this.sim(accountLabel);
    sim.protectionSubmits += 1;
    if (sim.script.kind === 'missing-stop') {
      return base(command, {
        entrySubmission: 'CONFIRMED',
        positionState: 'OPEN_UNPROTECTED',
        fill: fill(),
        target: target(),
      });
    }
    if (sim.script.kind === 'missing-target') {
      return base(command, {
        entrySubmission: 'CONFIRMED',
        positionState: 'OPEN_UNPROTECTED',
        fill: fill(),
        stop: stop(),
      });
    }
    return this.view(accountLabel, command, true);
  }
  async reconcile(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence> {
    const sim = this.sim(accountLabel);
    if (sim.script.kind === 'unknown-ambiguous' || sim.ambiguous)
      return base(command, {
        entrySubmission: 'UNKNOWN',
        positionState: 'UNKNOWN',
      });
    if (sim.script.kind === 'flatten-fails') {
      return base(command, {
        positionState: 'OPEN_PROTECTED' satisfies AccountPositionState,
        entrySubmission: 'CONFIRMED' satisfies EntrySubmission,
        fill: fill(),
        stop: stop(),
        target: target(),
        failureReason: 'FLATTEN_FAILED',
      });
    }
    if (!sim.filled) return this.view(accountLabel, command, false);
    if (
      sim.script.kind === 'missing-stop' ||
      sim.script.kind === 'missing-target'
    )
      return this.submitProtection(accountLabel, command);
    return protectedEvidence(command);
  }
  private sim(accountLabel: string): AccountSim {
    const sim = this.sims.get(accountLabel);
    if (!sim) throw new Error('ADAPTER_ERROR');
    return sim;
  }
  private view(
    accountLabel: string,
    command: EntryCommand,
    filled: boolean,
  ): AccountEvidence {
    const sim = this.sim(accountLabel);
    if (sim.filled || filled) return protectedEvidence(command);
    switch (sim.script.kind) {
      case 'wrong-account':
        return base(command, { observedAccount: sim.script.observed });
      case 'stale-header':
        return base(command, { pagesOpen: 2, ticketFresh: false });
      case 'leverage-mismatch':
        return base(command, { observedLeverage: sim.script.observed });
      case 'size-rejected':
        return base(command, {
          observedAllocation: null,
          observedOrderValue: null,
          failureReason: 'SIZE_REJECTED',
        });
      case 'session-loss':
        return base(command, { session: 'LOGIN_REQUIRED' });
      case 'opposing-position':
        return base(command, {
          otherEnabledPositions: [
            {
              accountLabel: 'Account 01',
              symbol: sim.script.symbol,
              side: sim.script.side,
              quantity: '1',
              enabled: sim.script.enabled ?? true,
            },
          ],
        });
      case 'flatten-fails':
        return base(command, {
          positionState: 'OPEN_PROTECTED',
          fill: fill(),
          stop: stop(),
          target: target(),
          failureReason: 'FLATTEN_FAILED',
        });
      default:
        return base(command);
    }
  }
}
