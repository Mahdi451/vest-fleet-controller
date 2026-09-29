import type {
  Account,
  Quote,
  RiskConfig,
  TradeIntent,
  ProtectionRequest,
  ProtectionOrder,
} from '../../core/src/index.ts';
import type { RiskPreview } from '../../risk-engine/src/index.ts';
import { z } from 'zod';
import {
  executionStateSchema,
  nonnegative,
  positive,
} from '../../core/src/index.ts';

const resultSchema = z
  .object({
    requestId: z.string(),
    accountId: z.string(),
    status: z.enum(['FILLED', 'REJECTED', 'UNKNOWN']),
    filledSize: nonnegative,
    entryPrice: positive.nullable(),
    fees: nonnegative,
    error: z.string().nullable(),
  })
  .strict();
export function validateResult(
  value: unknown,
  requestId: string,
  accountId: string,
): OrderResult {
  const result = resultSchema.parse(value);
  if (result.requestId !== requestId || result.accountId !== accountId)
    throw new Error('ADAPTER_IDENTITY_MISMATCH');
  return result;
}

export type OrderStatus = 'FILLED' | 'REJECTED' | 'UNKNOWN';
export interface OrderRequest {
  requestId: string;
  masterTradeId: string;
  accountId: string;
  intent: TradeIntent;
  preview: RiskPreview;
  quote: Quote;
  config: RiskConfig;
}
export interface OrderResult {
  requestId: string;
  accountId: string;
  status: OrderStatus;
  filledSize: string;
  entryPrice: string | null;
  fees: string;
  error: string | null;
}
// Raw entry acknowledgements and established child outcomes are distinct contracts.
export const childResultSchema = resultSchema.extend({
  state: executionStateSchema,
  protectionOrderIds: z.array(z.string()),
  stopPrice: positive.optional(),
  targetPrice: positive.optional(),
  cleanupStatus: z.enum(['FLAT', 'UNKNOWN']).optional(),
});
export type ChildResult = z.infer<typeof childResultSchema>;

export interface ExecutionAdapter {
  readonly name: string;
  readonly mode: 'SIMULATION';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listAccounts(): Promise<Account[]>;
  getAccountState(accountId: string): Promise<Account>;
  getQuote(): Promise<Quote>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  getOrder(requestId: string): Promise<OrderResult | null>;
  placeProtectionOrder(order: ProtectionRequest): Promise<ProtectionOrder>;
  getProtectionOrder(
    accountId: string,
    orderId: string,
  ): Promise<ProtectionOrder | null>;
  getOpenOrders(accountId: string): Promise<ProtectionOrder[]>;
  cancelOrder(accountId: string, orderId: string): Promise<void>;
  /** Close positions and cancel all protection; callers must reconcile both. */
  flattenAccount(accountId: string): Promise<void>;
}
// Native OCO, subscriptions and live capability discovery are not assumed.
// This minimal contract does not claim those capabilities exist at Vest.
