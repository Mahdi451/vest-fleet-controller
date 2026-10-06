import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authenticatedOfflineBridge } from '../packages/browser-execution/src/bridge/authenticated-channel.ts';
import {
  parseBridgeRequest,
  type OfflineBridgePort,
} from '../packages/browser-execution/src/bridge/protocol.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  options: Parameters<typeof authenticatedOfflineBridge>[2] = {},
  concurrent = true,
) {
  let now = 1000;
  let quarantineCount = 0;
  const started: string[] = [];
  const holds = new Map<string, ReturnType<typeof deferred>>();
  const backing: OfflineBridgePort = {
    environment: 'OFFLINE_FIXTURE',
    sessionId: randomUUID(),
    ...(concurrent ? { concurrency: 'ACCOUNT_BOUND' as const } : {}),
    async exchange(message) {
      const request = parseBridgeRequest(message);
      const accountId =
        'accountId' in request.payload ? request.payload.accountId : 'FLEET';
      started.push(accountId);
      await holds.get(accountId)?.promise;
      return JSON.stringify({
        version: 1,
        environment: 'OFFLINE_FIXTURE',
        sessionId: backing.sessionId,
        messageId: request.messageId,
        operation: request.operation,
        capturedAt: now,
        result: request.operation === 'CONNECT' ? 'CONNECTED' : null,
      });
    },
    async quarantine() {
      quarantineCount++;
    },
    async close() {},
  };
  const generations = {
    ownerGeneration: randomUUID(),
    controllerGeneration: randomUUID(),
    browserGeneration: randomUUID(),
  };
  const channel = authenticatedOfflineBridge(
    backing,
    generations,
    options,
    () => now,
  );
  const message = (accountId?: string, messageId = randomUUID()) =>
    JSON.stringify({
      version: 1,
      environment: 'OFFLINE_FIXTURE',
      sessionId: backing.sessionId,
      messageId,
      operation: accountId ? 'FLATTEN' : 'CONNECT',
      payload: accountId ? { accountId } : {},
    });
  return {
    backing,
    channel,
    started,
    holds,
    message,
    setTime: (value: number) => {
      now = value;
    },
    quarantines: () => quarantineCount,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('bounded authenticated synthetic channel', () => {
  it('keeps different accounts concurrent and completes responses out of order', async () => {
    const f = fixture();
    const hold = deferred();
    f.holds.set('account-02', hold);
    const first = f.channel.port.exchange(f.message('account-02'));
    await tick();
    await expect(
      f.channel.port.exchange(f.message('account-03')),
    ).resolves.toContain('FLATTEN');
    expect(f.started).toEqual(['account-02', 'account-03']);
    hold.resolve();
    await expect(first).resolves.toContain('FLATTEN');
    expect(f.channel.inspect().state).toBe('ACTIVE');
    expect(f.channel.port.concurrency).toBe('ACCOUNT_BOUND');
  });
  it('serializes direct callers targeting the same account until underlying settlement', async () => {
    const f = fixture();
    const hold = deferred();
    f.holds.set('account-02', hold);
    const first = f.channel.port.exchange(f.message('account-02'));
    const second = f.channel.port.exchange(f.message('account-02'));
    await tick();
    expect(f.started).toEqual(['account-02']);
    hold.resolve();
    await Promise.all([first, second]);
    expect(f.started).toEqual(['account-02', 'account-02']);
  });
  it('retains single-flight compatibility for undeclared backing ports', async () => {
    const f = fixture({}, false);
    const hold = deferred();
    f.holds.set('account-02', hold);
    const first = f.channel.port.exchange(f.message('account-02'));
    const firstRejected = expect(first).rejects.toThrow('UNCONFIRMED');
    await tick();
    await expect(
      f.channel.port.exchange(f.message('account-03')),
    ).rejects.toThrow('UNCONFIRMED');
    hold.resolve();
    await firstRejected;
    expect(f.channel.port.concurrency).toBeUndefined();
    expect(f.started).toEqual(['account-02']);
  });
  it.each([
    'sessionId',
    'ownerGeneration',
    'controllerGeneration',
    'browserGeneration',
    'direction',
    'sender',
    'receiver',
    'body',
    'signature',
  ])('rejects tampered %s before effects', async (field) => {
    const f = fixture({
      wireExchange: async (wire, receive) => {
        const parsed = JSON.parse(wire);
        parsed[field] =
          field.endsWith('Id') || field.endsWith('Generation')
            ? randomUUID()
            : field === 'signature'
              ? '0'.repeat(64)
              : field === 'body'
                ? '{}'
                : 'RESPONSE';
        return receive(JSON.stringify(parsed));
      },
    });
    await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(f.started).toEqual([]);
    expect(f.channel.inspect().state).toBe('QUARANTINED');
  });
  it('consumes request replay before a second dispatch', async () => {
    const f = fixture({
      wireExchange: async (wire, receive) => {
        await receive(wire);
        return receive(wire);
      },
    });
    await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(f.started).toEqual(['FLEET']);
  });
  it('rejects authenticated response replay on a new request', async () => {
    let saved = '';
    const f = fixture({
      wireExchange: async (wire, receive) => {
        const response = await receive(wire);
        if (!saved) {
          saved = response;
          return response;
        }
        return saved;
      },
    });
    await f.channel.port.exchange(f.message());
    await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(f.channel.inspect().state).toBe('QUARANTINED');
  });
  it('rejects valid authenticated responses swapped between concurrent requests', async () => {
    const ready = deferred();
    const responses: string[] = [];
    const f = fixture({
      wireExchange: async (wire, receive) => {
        const index = responses.length;
        responses.push('');
        responses[index] = await receive(wire);
        if (responses.every(Boolean) && responses.length === 2) ready.resolve();
        await ready.promise;
        return responses[1 - index]!;
      },
    });
    const results = await Promise.allSettled([
      f.channel.port.exchange(f.message('account-02')),
      f.channel.port.exchange(f.message('account-03')),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(f.channel.inspect().state).toBe('QUARANTINED');
  });
  it('fails closed on reordered request delivery', async () => {
    const firstHeld = deferred();
    let calls = 0;
    const f = fixture({
      wireExchange: async (wire, receive) => {
        if (++calls === 1) await firstHeld.promise;
        return receive(wire);
      },
    });
    const first = f.channel.port.exchange(f.message('account-02'));
    const rejected = expect(first).rejects.toThrow('UNCONFIRMED');
    await expect(
      f.channel.port.exchange(f.message('account-03')),
    ).rejects.toThrow('UNCONFIRMED');
    firstHeld.resolve();
    await rejected;
    expect(f.started).toEqual([]);
  });
  it('rejects responses after revocation and blocks queued account effects', async () => {
    const f = fixture();
    const hold = deferred();
    f.holds.set('account-02', hold);
    const requests = [
      f.channel.port.exchange(f.message('account-02')),
      f.channel.port.exchange(f.message('account-02')),
    ];
    const settled = Promise.allSettled(requests);
    await tick();
    f.channel.invalidate();
    hold.resolve();
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
    expect(f.started).toEqual(['account-02']);
  });
  it.each(['expiry', 'rollback', 'capability', 'session'])(
    'quarantines on %s changes before new effects',
    async (change) => {
      const f = fixture();
      await f.channel.port.exchange(f.message());
      if (change === 'expiry') f.setTime(61_000);
      if (change === 'rollback') f.setTime(999);
      if (change === 'capability')
        Object.defineProperty(f.backing, 'concurrency', { value: undefined });
      if (change === 'session')
        Object.defineProperty(f.backing, 'sessionId', { value: randomUUID() });
      await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
        'UNCONFIRMED',
      );
      expect(f.started).toEqual(['FLEET']);
      expect(f.quarantines()).toBe(1);
    },
  );
  it('bounds active admission before dispatch', async () => {
    const f = fixture({ maxInFlight: 1 });
    const hold = deferred();
    f.holds.set('account-02', hold);
    const first = f.channel.port.exchange(f.message('account-02'));
    const rejected = expect(first).rejects.toThrow('UNCONFIRMED');
    await tick();
    await expect(
      f.channel.port.exchange(f.message('account-03')),
    ).rejects.toThrow('UNCONFIRMED');
    hold.resolve();
    await rejected;
    expect(f.started).toEqual(['account-02']);
  });
  it('bounds lifetime request admission and prevents reused message identities', async () => {
    const f = fixture({ maxRequests: 1 });
    await f.channel.port.exchange(f.message());
    await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(f.started).toHaveLength(1);
    const other = fixture();
    const message = other.message();
    await other.channel.port.exchange(message);
    await expect(other.channel.port.exchange(message)).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(other.started).toHaveLength(1);
  });
  it('rejects stale queued requests before their backing operation starts', async () => {
    const f = fixture({ maxAgeMs: 5 });
    const hold = deferred();
    f.holds.set('account-02', hold);
    const settled = Promise.allSettled([
      f.channel.port.exchange(f.message('account-02')),
      f.channel.port.exchange(f.message('account-02')),
    ]);
    await tick();
    f.setTime(1006);
    hold.resolve();
    await settled;
    expect(f.started).toEqual(['account-02']);
    expect(f.channel.inspect().state).toBe('QUARANTINED');
  });
  it('quarantines malformed backing response correlations', async () => {
    const f = fixture();
    const exchange = f.backing.exchange.bind(f.backing);
    f.backing.exchange = async (message) => {
      const response = JSON.parse(await exchange(message));
      response.messageId = randomUUID();
      return JSON.stringify(response);
    };
    await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(f.channel.inspect().state).toBe('QUARANTINED');
  });
  it('prevents queued operations after backing failure', async () => {
    const f = fixture();
    const hold = deferred();
    let calls = 0;
    f.backing.exchange = async () => {
      calls++;
      await hold.promise;
      throw new Error('FIXTURE_FAILURE');
    };
    const settled = Promise.allSettled([
      f.channel.port.exchange(f.message('account-02')),
      f.channel.port.exchange(f.message('account-02')),
    ]);
    await tick();
    hold.resolve();
    expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
    expect(calls).toBe(1);
  });
  it('closing is terminal and does not expose key material', async () => {
    const f = fixture();
    await f.channel.port.close();
    await expect(f.channel.port.exchange(f.message())).rejects.toThrow(
      'UNCONFIRMED',
    );
    expect(f.channel.inspect().state).toBe('CLOSED');
    expect(Object.keys(f.channel.inspect())).not.toContain('requestKey');
    expect(f.started).toEqual([]);
  });
});
