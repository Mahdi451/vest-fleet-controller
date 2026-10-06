import { z } from 'zod';
import {
  accountSchema,
  decimal,
  intentSchema,
  nonnegative,
  protectionOrderSchema,
  protectionRequestSchema,
  quoteSchema,
  riskConfigSchema,
} from '../../../core/src/index.ts';
import { resultSchema } from '../../../execution/src/adapter.ts';

// This protocol describes synthetic evidence only. It contains no Vest URLs,
// credentials, provider payloads, or claim that local IDs are venue IDs.
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,100}$/);
const errorCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
  .nullable();
const previewSchema = z
  .object({
    accountId: id,
    approved: z.boolean(),
    reasons: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)),
    availableDrawdown: nonnegative,
    budget: nonnegative,
    quantity: nonnegative,
    notional: nonnegative,
    dollarPerPoint: nonnegative,
    stopRisk: nonnegative,
    entryFee: nonnegative,
    exitFee: nonnegative,
    slippage: nonnegative,
    funding: nonnegative,
    accountCost: nonnegative,
    totalPlannedLoss: nonnegative,
    remainingAfterStop: decimal,
    marginRequired: nonnegative,
    estimatedStop: decimal,
    estimatedTarget: decimal,
  })
  .strict();
const orderSchema = z
  .object({
    requestId: id,
    masterTradeId: id,
    accountId: id,
    intent: intentSchema,
    preview: previewSchema,
    quote: quoteSchema,
    config: riskConfigSchema,
  })
  .strict()
  .refine((order) => order.preview.accountId === order.accountId);
const empty = z.object({}).strict();
const account = z.object({ accountId: id }).strict();
const orderRef = z.object({ accountId: id, orderId: id }).strict();
const entryRef = z.object({ accountId: id, requestId: id }).strict();

export const bridgePayloadSchemas = {
  CONNECT: empty,
  LIST_ACCOUNTS: empty,
  ACCOUNT: account,
  QUOTE: empty,
  ENTRY: orderSchema,
  ORDER: entryRef,
  PROTECTION: protectionRequestSchema,
  PROTECTION_ORDER: orderRef,
  OPEN_ORDERS: account,
  CANCEL: orderRef,
  FLATTEN: account,
} as const;
export type BridgeOperation = keyof typeof bridgePayloadSchemas;

export const bridgeResultSchemas = {
  CONNECT: z.literal('CONNECTED'),
  LIST_ACCOUNTS: z.array(accountSchema).min(1),
  ACCOUNT: accountSchema,
  QUOTE: quoteSchema,
  ENTRY: resultSchema.extend({ error: errorCode }),
  ORDER: resultSchema.extend({ error: errorCode }).nullable(),
  PROTECTION: protectionOrderSchema.extend({ error: errorCode }),
  PROTECTION_ORDER: protectionOrderSchema
    .extend({ error: errorCode })
    .nullable(),
  OPEN_ORDERS: z.array(protectionOrderSchema.extend({ error: errorCode })),
  CANCEL: z.null(),
  FLATTEN: z.null(),
} as const;
export type BridgePayload<K extends BridgeOperation> = z.infer<
  (typeof bridgePayloadSchemas)[K]
>;
export type BridgeResult<K extends BridgeOperation> = z.infer<
  (typeof bridgeResultSchemas)[K]
>;

const envelope = {
  version: z.literal(1),
  environment: z.literal('OFFLINE_FIXTURE'),
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  operation: z.enum(
    Object.keys(bridgePayloadSchemas) as [
      BridgeOperation,
      ...BridgeOperation[],
    ],
  ),
};
export const bridgeRequestSchema = z
  .object({ ...envelope, payload: z.unknown() })
  .strict();
export const bridgeResponseSchema = z
  .object({
    ...envelope,
    capturedAt: z.number().int().nonnegative(),
    result: z.unknown(),
  })
  .strict();
export const MAX_BRIDGE_MESSAGE_BYTES = 1_000_000;

export function bridgeMessageBytes(message: string): number {
  return new TextEncoder().encode(message).byteLength;
}

/** Parse only the selected operation's strict payload; never forward raw data. */
export function parseBridgeRequest(message: string) {
  const request = bridgeRequestSchema.parse(parseMessage(message));
  return {
    ...request,
    payload: bridgePayloadSchemas[request.operation].parse(request.payload),
  };
}
export function parseMessage(message: string): unknown {
  if (bridgeMessageBytes(message) > MAX_BRIDGE_MESSAGE_BYTES)
    throw new Error('BRIDGE_MESSAGE_TOO_LARGE');
  return JSON.parse(message);
}

/** In-memory test transport, not a browser injection or authenticated provider. */
export interface OfflineBridgePort {
  readonly environment: 'OFFLINE_FIXTURE';
  readonly sessionId: string;
  readonly concurrency?: 'ACCOUNT_BOUND';
  exchange(message: string): Promise<string>;
  quarantine(): Promise<void>;
  close(): Promise<void>;
}
