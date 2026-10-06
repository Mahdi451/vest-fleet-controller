import { randomUUID } from 'node:crypto';
import {
  bridgePayloadSchemas,
  bridgeResultSchemas,
  parseBridgeRequest,
  type OfflineBridgePort,
} from '../../packages/browser-execution/src/bridge/protocol.ts';
import type { MockVestAdapter } from '../../packages/simulator/src/index.ts';

/** Synthetic message exchange. Never installs a script or contacts Vest. */
export function offlineBridge(mock: MockVestAdapter, clock: () => number) {
  const messages: string[] = [];
  const writes: string[] = [];
  let quarantined = false;
  const port: OfflineBridgePort = {
    environment: 'OFFLINE_FIXTURE',
    concurrency: 'ACCOUNT_BOUND',
    sessionId: randomUUID(),
    async exchange(message) {
      if (quarantined) throw new Error('FIXTURE_CLOSED');
      const request = parseBridgeRequest(message);
      if (request.sessionId !== port.sessionId)
        throw new Error('FIXTURE_SESSION_MISMATCH');
      messages.push(message);
      const payload = request.payload;
      let result: unknown;
      switch (request.operation) {
        case 'CONNECT':
          result = 'CONNECTED';
          break;
        case 'LIST_ACCOUNTS':
          result = await mock.listAccounts();
          break;
        case 'ACCOUNT':
          result = await mock.getAccountState(
            bridgePayloadSchemas.ACCOUNT.parse(payload).accountId,
          );
          break;
        case 'QUOTE':
          result = await mock.getQuote();
          break;
        case 'ENTRY':
          writes.push('ENTRY');
          result = await mock.placeOrder(
            bridgePayloadSchemas.ENTRY.parse(payload),
          );
          break;
        case 'ORDER':
          result = await mock.getOrder(
            bridgePayloadSchemas.ORDER.parse(payload).requestId,
          );
          break;
        case 'PROTECTION':
          writes.push('PROTECTION');
          result = await mock.placeProtectionOrder(
            bridgePayloadSchemas.PROTECTION.parse(payload),
          );
          break;
        case 'PROTECTION_ORDER': {
          const ref = bridgePayloadSchemas.PROTECTION_ORDER.parse(payload);
          result = await mock.getProtectionOrder(ref.accountId, ref.orderId);
          break;
        }
        case 'OPEN_ORDERS':
          result = await mock.getOpenOrders(
            bridgePayloadSchemas.OPEN_ORDERS.parse(payload).accountId,
          );
          break;
        case 'CANCEL': {
          writes.push('CANCEL');
          const ref = bridgePayloadSchemas.CANCEL.parse(payload);
          await mock.cancelOrder(ref.accountId, ref.orderId);
          result = null;
          break;
        }
        case 'FLATTEN':
          writes.push('FLATTEN');
          await mock.flattenAccount(
            bridgePayloadSchemas.FLATTEN.parse(payload).accountId,
          );
          result = null;
          break;
      }
      return JSON.stringify({
        version: request.version,
        environment: request.environment,
        sessionId: request.sessionId,
        messageId: request.messageId,
        operation: request.operation,
        capturedAt: clock(),
        result: bridgeResultSchemas[request.operation].parse(result),
      });
    },
    async quarantine() {
      quarantined = true;
    },
    async close() {
      quarantined = true;
    },
  };
  return { port, messages, writes };
}
