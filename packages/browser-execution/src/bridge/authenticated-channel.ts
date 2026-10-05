import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import {
  bridgeMessageBytes,
  bridgeResponseSchema,
  bridgeResultSchemas,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseBridgeRequest,
  parseMessage,
  type OfflineBridgePort,
} from './protocol.ts';

const generationsSchema = z
  .object({
    ownerGeneration: z.string().uuid(),
    controllerGeneration: z.string().uuid(),
    browserGeneration: z.string().uuid(),
  })
  .strict();
export type OfflineChannelGenerations = z.infer<typeof generationsSchema>;
const wireSchema = z
  .object({
    version: z.literal(1),
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
    channelId: z.string().uuid(),
    sessionId: z.string().uuid(),
    ...generationsSchema.shape,
    direction: z.enum(['REQUEST', 'RESPONSE']),
    sender: z.enum(['CONTROLLER', 'BROWSER_FIXTURE']),
    receiver: z.enum(['CONTROLLER', 'BROWSER_FIXTURE']),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sentAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    body: z.string().max(MAX_BRIDGE_MESSAGE_BYTES),
    signature: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Wire = z.infer<typeof wireSchema>;
type UnsignedWire = Omit<Wire, 'signature'>;
export const MAX_AUTHENTICATED_MESSAGE_BYTES =
  MAX_BRIDGE_MESSAGE_BYTES * 2 + 2000;

// Fixed field order and domain separate these MACs from any other application.
function authenticatedBytes(wire: UnsignedWire): string {
  return JSON.stringify([
    'VEST_FLEET_SYNTHETIC_CHANNEL_V1',
    wire.version,
    wire.environment,
    wire.evidence,
    wire.channelId,
    wire.sessionId,
    wire.ownerGeneration,
    wire.controllerGeneration,
    wire.browserGeneration,
    wire.direction,
    wire.sender,
    wire.receiver,
    wire.sequence,
    wire.sentAt,
    wire.expiresAt,
    wire.body,
  ]);
}

/**
 * Trusted in-memory provisioning only. No sockets, browser injection or Vest access.
 * Possession of a peer key authenticates synthetic messages; it does not arm trading.
 * A real browser requires a separately reviewed provisioning and dispatch boundary.
 */
export function authenticatedOfflineBridge(
  backing: OfflineBridgePort,
  generations: OfflineChannelGenerations,
  options: {
    lifetimeMs?: number;
    maxAgeMs?: number;
    // Adversarial fixture transport sees wire data and a verifying receiver only.
    wireExchange?: (
      wire: string,
      receive: (wire: string) => Promise<string>,
    ) => Promise<string>;
  } = {},
  clock: () => number = Date.now,
) {
  const identity = generationsSchema.safeParse(generations);
  const session = z.string().uuid().safeParse(backing.sessionId);
  const lifetimeMs = options.lifetimeMs ?? 60_000;
  const maxAgeMs = options.maxAgeMs ?? 5000;
  const createdAt = clock();
  if (
    !identity.success ||
    !session.success ||
    backing.environment !== 'OFFLINE_FIXTURE' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    ![lifetimeMs, maxAgeMs].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= 60_000,
    ) ||
    !Number.isSafeInteger(createdAt + lifetimeMs)
  )
    throw new Error('INVALID_OFFLINE_CHANNEL');
  const binding = {
    version: 1 as const,
    environment: 'OFFLINE_FIXTURE' as const,
    evidence: 'SYNTHETIC' as const,
    channelId: randomUUID(),
    sessionId: session.data,
    ...identity.data,
    expiresAt: createdAt + lifetimeMs,
  };
  // Private closures: neither inspection nor test interception exposes these keys.
  const requestKey = randomBytes(32);
  const responseKey = randomBytes(32);
  let state: 'ACTIVE' | 'QUARANTINED' | 'CLOSED' = 'ACTIVE';
  let lastObservedAt = createdAt;
  let nextOutbound = 1;
  let nextRequest = 1;
  let nextResponse = 1;
  let busy = false;
  let dispatching = false;
  function revoke(next: 'QUARANTINED' | 'CLOSED') {
    if (state === 'CLOSED' || (state === 'QUARANTINED' && next !== 'CLOSED'))
      return;
    state = next;
    requestKey.fill(0);
    responseKey.fill(0);
    void backing.quarantine().catch(() => {});
  }
  function assertActive() {
    const now = clock();
    if (
      state !== 'ACTIVE' ||
      !Number.isSafeInteger(now) ||
      now < lastObservedAt ||
      now >= binding.expiresAt ||
      backing.environment !== binding.environment ||
      backing.sessionId !== binding.sessionId
    ) {
      revoke('QUARANTINED');
      throw new Error('OFFLINE_CHANNEL_UNAVAILABLE');
    }
    lastObservedAt = now;
    return now;
  }
  function seal(direction: Wire['direction'], sequence: number, body: string) {
    const wire: UnsignedWire = {
      ...binding,
      direction,
      sender: direction === 'REQUEST' ? 'CONTROLLER' : 'BROWSER_FIXTURE',
      receiver: direction === 'REQUEST' ? 'BROWSER_FIXTURE' : 'CONTROLLER',
      sequence,
      sentAt: assertActive(),
      body,
    };
    if (bridgeMessageBytes(body) > MAX_BRIDGE_MESSAGE_BYTES)
      throw new Error('OFFLINE_CHANNEL_BODY_TOO_LARGE');
    const signature = createHmac(
      'sha256',
      direction === 'REQUEST' ? requestKey : responseKey,
    )
      .update(authenticatedBytes(wire))
      .digest('hex');
    const message = JSON.stringify({ ...wire, signature });
    if (bridgeMessageBytes(message) > MAX_AUTHENTICATED_MESSAGE_BYTES)
      throw new Error('OFFLINE_CHANNEL_MESSAGE_TOO_LARGE');
    return message;
  }
  function open(message: string, direction: Wire['direction']) {
    const now = assertActive();
    if (bridgeMessageBytes(message) > MAX_AUTHENTICATED_MESSAGE_BYTES)
      throw new Error('OFFLINE_CHANNEL_MESSAGE_TOO_LARGE');
    const wire = wireSchema.parse(JSON.parse(message));
    const signature = createHmac(
      'sha256',
      direction === 'REQUEST' ? requestKey : responseKey,
    )
      .update(authenticatedBytes(wire))
      .digest();
    if (
      !timingSafeEqual(signature, Buffer.from(wire.signature, 'hex')) ||
      wire.channelId !== binding.channelId ||
      wire.sessionId !== binding.sessionId ||
      wire.ownerGeneration !== binding.ownerGeneration ||
      wire.controllerGeneration !== binding.controllerGeneration ||
      wire.browserGeneration !== binding.browserGeneration ||
      wire.expiresAt !== binding.expiresAt ||
      wire.direction !== direction ||
      wire.sender !==
        (direction === 'REQUEST' ? 'CONTROLLER' : 'BROWSER_FIXTURE') ||
      wire.receiver !==
        (direction === 'REQUEST' ? 'BROWSER_FIXTURE' : 'CONTROLLER') ||
      wire.sequence !==
        (direction === 'REQUEST' ? nextRequest : nextResponse) ||
      wire.sentAt > now ||
      now - wire.sentAt > maxAgeMs ||
      bridgeMessageBytes(wire.body) > MAX_BRIDGE_MESSAGE_BYTES
    )
      throw new Error('OFFLINE_CHANNEL_PROOF_REFUSED');
    // Consume before dispatch. A lost response never permits this message again.
    if (direction === 'REQUEST') nextRequest++;
    else nextResponse++;
    return wire;
  }
  function responseBody(
    body: string,
    request: ReturnType<typeof parseBridgeRequest>,
  ) {
    const response = bridgeResponseSchema.parse(parseMessage(body));
    const now = assertActive();
    if (
      response.sessionId !== binding.sessionId ||
      response.messageId !== request.messageId ||
      response.operation !== request.operation ||
      response.capturedAt > now ||
      now - response.capturedAt > maxAgeMs
    )
      throw new Error('OFFLINE_CHANNEL_RESPONSE_REFUSED');
    return JSON.stringify({
      ...response,
      result: bridgeResultSchemas[response.operation].parse(response.result),
    });
  }
  async function receive(message: string): Promise<string> {
    try {
      if (dispatching) throw new Error('OFFLINE_CHANNEL_BUSY');
      const wire = open(message, 'REQUEST');
      const request = parseBridgeRequest(wire.body);
      if (request.sessionId !== binding.sessionId)
        throw new Error('OFFLINE_CHANNEL_SESSION_REFUSED');
      dispatching = true;
      // No await between this check and the trusted fixture dispatch.
      assertActive();
      const body = await backing.exchange(JSON.stringify(request));
      assertActive();
      const response = responseBody(body, request);
      if (JSON.parse(response).capturedAt < wire.sentAt)
        throw new Error('OFFLINE_CHANNEL_CAPTURE_REFUSED');
      return seal('RESPONSE', wire.sequence, response);
    } catch {
      revoke('QUARANTINED');
      throw new Error('AUTHENTICATED_CHANNEL_UNCONFIRMED');
    } finally {
      dispatching = false;
    }
  }
  const port: OfflineBridgePort = {
    environment: 'OFFLINE_FIXTURE',
    sessionId: binding.sessionId,
    async exchange(message) {
      try {
        assertActive();
        if (busy) throw new Error('OFFLINE_CHANNEL_BUSY');
        const request = parseBridgeRequest(message);
        if (request.sessionId !== binding.sessionId)
          throw new Error('OFFLINE_CHANNEL_SESSION_REFUSED');
        busy = true;
        const outgoing = seal(
          'REQUEST',
          nextOutbound++,
          JSON.stringify(request),
        );
        const wire = options.wireExchange
          ? await options.wireExchange(outgoing, receive)
          : await receive(outgoing);
        assertActive();
        const incoming = open(wire, 'RESPONSE');
        return responseBody(incoming.body, request);
      } catch {
        revoke('QUARANTINED');
        throw new Error('AUTHENTICATED_CHANNEL_UNCONFIRMED');
      } finally {
        busy = false;
      }
    },
    async quarantine() {
      revoke('QUARANTINED');
    },
    async close() {
      revoke('CLOSED');
      try {
        await backing.close();
      } catch {
        throw new Error('OFFLINE_CHANNEL_CLOSE_UNCONFIRMED');
      }
    },
  };
  return {
    port,
    invalidate: () => revoke('QUARANTINED'),
    inspect: () => {
      try {
        assertActive();
      } catch {
        // Inspection reports terminal state; it never restores a session.
      }
      return { ...binding, state };
    },
  };
}
