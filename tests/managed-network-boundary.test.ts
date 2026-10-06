import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createManagedFixture } from '../packages/browser-execution/src/managed-fixture.ts';
import { observeManagedLaunch } from './fixtures/managed-vest-page.ts';
import { config, NOW } from './helpers.ts';

async function fixture(
  run: (
    managed: Awaited<ReturnType<typeof createManagedFixture>>,
    observed: ReturnType<typeof observeManagedLaunch>,
  ) => Promise<void>,
) {
  const observed = observeManagedLaunch();
  const managed = await createManagedFixture(config, () => NOW);
  try {
    await run(managed, observed);
  } finally {
    await managed.close();
    observed.restore();
  }
}

describe('exact owned fixture network capabilities', () => {
  it('allows only generated GET page/script routes while preserving account reads', async () =>
    fixture(async (managed, observed) => {
      const context = managed
        .inspect()
        .contexts.find((value) => value.accountId === '02')!;
      const page = observed
        .context()
        .pages()
        .find((value) => value.url().endsWith(context.contextId))!;
      expect(
        await page.evaluate(async (contextId) => {
          const response = await fetch(`/fixture/${contextId}.js`);
          return response.status;
        }, context.contextId),
      ).toBe(200);
      expect(managed.inspect().blockedRequests).toBe(0);
      expect(await managed.adapter.listAccounts()).toHaveLength(10);
    }));
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
    'blocks %s even on an approved page route',
    async (method) =>
      fixture(async (managed, observed) => {
        const page = observed.context().pages()[0]!;
        await page.evaluate(async (verb) => {
          try {
            await fetch(location.href, { method: verb });
          } catch {
            /* expected network refusal */
          }
        }, method);
        expect(managed.inspect()).toMatchObject({
          state: 'HALTED',
          session: 'LOCKED',
          blockedRequests: 1,
        });
        await expect(managed.adapter.listAccounts()).rejects.toThrow(
          'MANAGED_FIXTURE_LOCKED',
        );
      }),
  );
  it.each([
    '?unreviewed=1',
    '/unreviewed',
    '/%2e%2e/unknown',
    '?redirect=http%3A%2F%2F127.0.0.2',
    '/%00',
  ])('rejects route alteration %s', async (suffix) =>
    fixture(async (managed, observed) => {
      const page = observed.context().pages()[0]!;
      await page.evaluate(async (value) => {
        try {
          await fetch(location.href + value);
        } catch {
          /* expected */
        }
      }, suffix);
      expect(managed.inspect().state).toBe('HALTED');
      expect(managed.inspect().blockedRequests).toBe(1);
    }),
  );
  it('refuses a different loopback port before delivering a request or payload', async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits++;
      response.end('canary');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('NO_CANARY_PORT');
    try {
      await fixture(async (managed, observed) => {
        await observed
          .context()
          .pages()[0]!
          .goto(
            `http://127.0.0.1:${address.port}/synthetic-secret_7626acdda6ef4d28a815df0a440f0997`,
          )
          .catch(() => {});
        expect(managed.inspect().state).toBe('HALTED');
        expect(hits).toBe(0);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each(['Authorization', 'Proxy-Authorization'])(
    'blocks %s on an otherwise allowed route',
    async (name) =>
      fixture(async (managed, observed) => {
        const page = observed.context().pages()[0]!;
        await page.setExtraHTTPHeaders({
          [name]: 'synthetic-secret_1cae9cb527764bc4b755cfcfe4c0a4f4',
        });
        await page.reload().catch(() => {});
        expect(managed.inspect().state).toBe('HALTED');
        expect(managed.inspect().blockedRequests).toBeGreaterThan(0);
      }),
  );
  it('fails closed if request header inspection cannot be completed', async () =>
    fixture(async (managed, observed) => {
      const page = observed.context().pages()[0]!;
      page.once('request', (request) => {
        vi.spyOn(request, 'allHeaders').mockRejectedValueOnce(
          new Error('synthetic-secret_2c8021e1cc154e5986f097049c33118e'),
        );
      });
      await page.reload().catch(() => {});
      expect(managed.inspect().state).toBe('HALTED');
      expect(managed.inspect().blockedRequests).toBeGreaterThan(0);
      expect(JSON.stringify(managed.inspect())).not.toContain(
        'synthetic-secret',
      );
    }));
  it('rejects credential-bearing navigation to a generated page', async () =>
    fixture(async (managed, observed) => {
      const page = observed.context().pages()[0]!;
      const url = new URL(page.url());
      url.username = 'synthetic-user';
      url.password = 'synthetic-secret_279786c6fe2f4b9cb5d63a42e14f3f3d';
      await page.goto(url.href).catch(() => {});
      expect(managed.inspect().state).toBe('HALTED');
      expect(managed.inspect().session).toBe('LOCKED');
    }));
  it('refuses WebSockets to the owned fixture origin', async () =>
    fixture(async (managed, observed) => {
      await observed
        .context()
        .pages()[0]!
        .evaluate(async () => {
          const socket = new WebSocket(
            location.origin.replace('http:', 'ws:') + '/unknown',
          );
          await new Promise<void>((resolve) => {
            socket.onclose = () => resolve();
            socket.onerror = () => resolve();
          });
        });
      expect(managed.inspect().state).toBe('HALTED');
      expect(managed.inspect().blockedRequests).toBe(1);
    }));
});
