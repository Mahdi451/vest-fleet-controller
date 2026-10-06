import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { request } from 'playwright';
import { createDashboard } from '../apps/dashboard/server.ts';
import { PrivateAccess } from '../apps/dashboard/src/private-access.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { privateHost } from './fixtures/private-host.ts';
import { config, NOW } from './helpers.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('copier authorization across lazy initialization', () => {
  it.each(['logout', 'revoke-sessions'])(
    'refuses a pending arm after %s',
    async (action) => {
      const host = await privateHost();
      const reservation = createServer();
      await new Promise<void>((resolve) =>
        reservation.listen(0, '127.0.0.1', resolve),
      );
      const address = reservation.address();
      if (!address || typeof address === 'string')
        throw new Error('NO_ADDRESS');
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
      const origin = `https://localhost:${port}`;
      const app = await createDashboard(
        config,
        host.directory,
        false,
        new PrivateAccess({ ...host.config, origin, port }, host.tls),
        { now: () => NOW },
      );
      const api = await request.newContext({ ignoreHTTPSErrors: true });
      const gate = deferred(),
        started = deferred();
      try {
        await new Promise<void>((resolve) =>
          app.server.listen(port, '127.0.0.1', resolve),
        );
        expect(
          (
            await api.post(`${origin}/api/login`, {
              data: { secret: host.secret },
              headers: { Origin: origin },
            })
          ).status(),
        ).toBe(200);
        // Obtain CSRF from the legacy state without starting copier initialization.
        const state = await (await api.get(`${origin}/api/state`)).json();
        const original = MockVestAdapter.prototype.connect;
        vi.spyOn(MockVestAdapter.prototype, 'connect').mockImplementation(
          async function (this: MockVestAdapter) {
            started.resolve();
            await gate.promise;
            return original.call(this);
          },
        );
        const submit = vi.spyOn(MockVestAdapter.prototype, 'placeOrder');
        const headers = { Origin: origin, 'X-Session-Token': state.token };
        const arm = api.post(`${origin}/api/copier/arm`, {
          headers,
          data: {
            followers: ['02'],
            maxLeverage: '50',
            maxNotional: '100000',
            maxPlannedLoss: '10',
            durationMs: 10000,
          },
        });
        await started.promise;
        expect(
          (
            await api.post(`${origin}/api/${action}`, { headers, data: {} })
          ).status(),
        ).toBe(200);
        gate.resolve();
        expect((await arm).status()).toBe(403);
        expect(
          (
            await api.post(`${origin}/api/login`, {
              data: { secret: host.secret },
              headers: { Origin: origin },
            })
          ).status(),
        ).toBe(200);
        const copier = await (
          await api.get(`${origin}/api/copier/state`)
        ).json();
        expect(copier.session).toBe('LOCKED');
        expect(copier.liveState).toBe('LOCKED');
        expect(copier.liveSend).toBe(false);
        expect(submit).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await api.dispose();
        await app.close();
        vi.restoreAllMocks();
        await host.dispose();
      }
    },
  );
});
