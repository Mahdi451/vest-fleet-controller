import type { TradeIntent } from '../../../core/src/index.ts';

/**
 * Window A owns VestExecutionPage in single-account.ts.
 * A live adapter maps that page onto CopierExecutionAdapter.
 * inspect reads the account, symbol, ticket, position, and exits.
 * submit may click once. CLICKED is not confirmation.
 * CLICK_UNKNOWN becomes entrySubmission UNKNOWN.
 * reconcile reads again and must not call submitEntry.
 * A completed browser click is not a field on this contract.
 */
export type ExecutionPhase =
  | 'PREVIEWED'
  | 'ACCOUNT_VERIFYING'
  | 'TICKET_VERIFYING'
  | 'ENTRY_READY'
  | 'ENTRY_SUBMITTING'
  | 'ENTRY_UNKNOWN'
  | 'ENTRY_FILLED'
  | 'ENTRY_FILLED_UNPROTECTED'
  | 'PROTECTION_SUBMITTING'
  | 'PROTECTED'
  | 'VERIFIED'
  | 'HALTED';

export type AccountPositionState =
  | 'UNKNOWN'
  | 'FLAT'
  | 'OPEN_UNPROTECTED'
  | 'OPEN_PROTECTED'
  | 'EXITING'
  | 'CONFIRMED_FLAT'
  | 'HALTED';

export type EntrySubmission =
  'NONE' | 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'REJECTED';

export interface FillEvidence {
  readonly price: string;
  readonly quantity: string;
}

export interface ExitEvidence {
  readonly price: string;
  readonly reduceOnly: boolean;
}

export interface ObservedPosition {
  readonly accountLabel: string;
  readonly symbol: string;
  readonly side: TradeIntent['side'];
  readonly quantity: string;
  readonly enabled: boolean;
}

/** Facts read from the venue. Memory of a request is not a member of this type. */
export interface AccountEvidence {
  readonly expectedAccount: string;
  readonly observedAccount: string | null;
  readonly symbol: string | null;
  readonly requestedLeverage: string;
  readonly observedLeverage: string | null;
  readonly requestedAllocation: string;
  readonly observedAllocation: string | null;
  readonly observedOrderValue: string | null;
  readonly entrySubmission: EntrySubmission;
  readonly positionState: AccountPositionState;
  readonly fill: FillEvidence | null;
  readonly stop: ExitEvidence | null;
  readonly target: ExitEvidence | null;
  readonly pagesOpen: number;
  readonly session: 'AUTHENTICATED' | 'LOGIN_REQUIRED' | 'UNKNOWN';
  readonly marketClosed: boolean;
  readonly ticketFresh: boolean;
  readonly otherEnabledPositions: readonly ObservedPosition[];
  readonly failureReason: string | null;
}

export interface EntryCommand {
  readonly accountLabel: string;
  readonly symbol: string;
  readonly side: TradeIntent['side'];
  readonly leverage: string;
  readonly allocation: string;
  readonly orderValueCap: string;
}

export interface CopierExecutionAdapter {
  readonly name: string;
  inspect(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence>;
  submit(accountLabel: string, command: EntryCommand): Promise<AccountEvidence>;
  submitProtection(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence>;
  reconcile(
    accountLabel: string,
    command: EntryCommand,
  ): Promise<AccountEvidence>;
}
