import type {
  Account,
  Quote,
  RiskConfig,
  TradeIntent,
} from '../../core/src/index.ts';
import type { RiskPreview } from '../../risk-engine/src/index.ts';
import { z } from 'zod';
import { nonnegative, positive } from '../../core/src/index.ts';

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
  flattenAccount(accountId: string): Promise<void>;
}
// Limit/cancel orders, subscriptions and live capability discovery belong to M5.
// This minimal contract does not claim those capabilities exist at Vest.
