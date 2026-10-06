import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';
import {
  accountSchema,
  positionSchema,
  protectionOrderSchema,
  protectionRequestSchema,
  quoteSchema,
  riskConfigSchema,
  type RiskConfig,
  type ProtectionRequest,
} from '../../core/src/index.ts';
import {
  resultSchema,
  type OrderRequest,
} from '../../execution/src/adapter.ts';
import {
  ownedMutationRequestSchema,
  ownedMutationReceiptSchema,
  type OwnedMutationRequest,
} from '../../execution/src/owned-mutation-contract.ts';
import { MockVestAdapter } from '../../simulator/src/index.ts';
import { bridgePayloadSchemas } from './bridge/protocol.ts';

export type ManagedFixtureLifecycle = {
  environment: 'OFFLINE_FIXTURE';
  evidence: 'SYNTHETIC';
  scope: 'ACCOUNT' | 'GLOBAL';
  reason: 'CONTEXT_LOST' | 'IDENTITY_UNCERTAIN' | 'CHANNEL_INTEGRITY_LOST';
  accountId: string | null;
};
const accountIdSchema = z.string().regex(/^0[1-9]$|^10$/);
const identitySchema = z
  .object({
    accountId: accountIdSchema,
    contextId: z.string().uuid(),
    generation: z.string().uuid(),
    environment: z.literal('OFFLINE_FIXTURE'),
    evidence: z.literal('SYNTHETIC'),
  })
  .strict();
type Identity = z.infer<typeof identitySchema>;
type FixtureWindow = {
  fixture: {
    identity: Identity;
    invoke: Record<string, (payload: unknown) => Promise<unknown>>;
  };
};
const names = [
  'readAccounts',
  'readAccount',
  'readPositions',
  'readQuote',
  'readOrders',
  'submitEntry',
  'readEntry',
  'submitStop',
  'submitTarget',
  'readProtection',
  'cancelOrder',
  'flattenOwnedPosition',
  'repairOwnedProtection',
  'addOwnedPosition',
  'reduceOwnedPosition',
  'closeOwnedPosition',
  'changeOwnedProtection',
  'readOwnedMutation',
] as const;
type Operation = (typeof names)[number];
const writeOperations = new Set<Operation>([
  'submitEntry',
  'submitStop',
  'submitTarget',
  'cancelOrder',
  'flattenOwnedPosition',
  'repairOwnedProtection',
  'addOwnedPosition',
  'reduceOwnedPosition',
  'closeOwnedPosition',
  'changeOwnedProtection',
]);
const ref = z.object({ accountId: accountIdSchema }).strict();
const orderRef = z
  .object({ accountId: accountIdSchema, orderId: z.string().min(1).max(100) })
  .strict();
const empty = z.object({}).strict();
const invocationSchema = z
  .object({ id: z.string().uuid(), payload: z.unknown() })
  .strict();
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'UNDEFINED')
    .digest('hex');

/** Owns only a generated local synthetic page. Never attaches to an existing browser. */
export async function createManagedFixture(
  configInput: RiskConfig,
  clock: () => number = Date.now,
  persistentNamespaceProfile = false,
) {
  if (typeof persistentNamespaceProfile !== 'boolean')
    throw new Error('MANAGED_FIXTURE_PROFILE_REFUSED');
  const parsedConfig = riskConfigSchema.safeParse(configInput);
  if (!parsedConfig.success) throw new Error('MANAGED_FIXTURE_CONFIG_REFUSED');
  const config = parsedConfig.data,
    generation = randomUUID();
  if (
    persistentNamespaceProfile &&
    process.env.VEST_FIXTURE_PERSISTENT_PROFILE !== '1'
  )
    throw new Error('MANAGED_FIXTURE_PROFILE_REFUSED');
  const profile = persistentNamespaceProfile
    ? '/tmp/owned-browser-profile'
    : mkdtempSync(join(tmpdir(), 'vest-managed-fixture-'));
  const mock = new MockVestAdapter(config, clock);
  const identities = new Map<string, Identity>(),
    pages = new Map<string, Page>();
  const unavailable = new Set<string>(),
    listeners = new Set<(event: ManagedFixtureLifecycle) => void>();
  const lanes = new Map<string, Promise<void>>(),
    pending = new Map<string, Set<Promise<unknown>>>();
  const entries = new Map<string, string>(),
    mutations = new Map<string, string>();
  const invocations = new Map<
    string,
    {
      id: string;
      operation: Operation;
      payloadHash: string;
      claimed: boolean;
      replied: boolean;
      reply: unknown;
    }
  >();
  let context: BrowserContext | undefined,
    origin = '',
    armed = false,
    closing = false,
    provisioning = true,
    armRevision = 0;
  let state: 'READY' | 'HALTED' | 'CLOSED' = 'READY',
    blockedRequests = 0;
  const emit = (
    scope: ManagedFixtureLifecycle['scope'],
    reason: ManagedFixtureLifecycle['reason'],
    accountId: string | null,
  ) => {
    if (scope === 'GLOBAL') {
      armed = false;
      armRevision++;
      if (state !== 'CLOSED') state = 'HALTED';
    } else if (accountId) {
      unavailable.add(accountId);
      armRevision++;
    }
    const event: ManagedFixtureLifecycle = {
      environment: 'OFFLINE_FIXTURE',
      evidence: 'SYNTHETIC',
      scope,
      reason,
      accountId,
    };
    for (const listener of listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* Observer errors cannot restore authority. */
      }
    }
  };
  const active = (accountId: string, writing = false) => {
    if (state !== 'READY' || closing || (writing && !armed))
      throw new Error('MANAGED_FIXTURE_LOCKED');
    if (unavailable.has(accountId))
      throw new Error('MANAGED_FIXTURE_CONTEXT_LOST');
    if (!pages.has(accountId))
      throw new Error('MANAGED_FIXTURE_ACCOUNT_UNPROVEN');
  };
  const pageIdentity = async (accountId: string) => {
    active(accountId);
    const page = pages.get(accountId)!,
      identity = identities.get(accountId)!;
    if (
      page.isClosed() ||
      page.url() !== `${origin}/context/${identity.contextId}`
    ) {
      emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', accountId);
      throw new Error('MANAGED_FIXTURE_IDENTITY_UNPROVEN');
    }
    let facts: unknown;
    try {
      facts = await page.evaluate(
        () => (globalThis as unknown as FixtureWindow).fixture.identity,
      );
    } catch {
      if (!closing)
        emit(
          accountId === '01' ? 'GLOBAL' : 'ACCOUNT',
          'IDENTITY_UNCERTAIN',
          accountId,
        );
      throw new Error('MANAGED_FIXTURE_IDENTITY_UNPROVEN');
    }
    const parsed = identitySchema.safeParse(facts);
    if (
      !parsed.success ||
      JSON.stringify(parsed.data) !== JSON.stringify(identity)
    ) {
      emit(
        accountId === '01' ? 'GLOBAL' : 'ACCOUNT',
        'IDENTITY_UNCERTAIN',
        accountId,
      );
      throw new Error('MANAGED_FIXTURE_IDENTITY_UNPROVEN');
    }
    return page;
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
    );
    const identity = [...identities.values()].find(
      (value) =>
        request.url === `/context/${value.contextId}` ||
        request.url === `/fixture/${value.contextId}.js`,
    );
    if (
      request.method !== 'GET' ||
      Object.keys(request.headers).some((name) =>
        /^(?:proxy-)?authorization$/i.test(name),
      ) ||
      request.headers.host !== new URL(origin).host ||
      !identity
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.url?.startsWith('/context/')) {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        `<html><head><link rel="icon" href="data:," /><script src="/fixture/${identity.contextId}.js"></script></head><body>OFFLINE FIXTURE · SYNTHETIC ACCOUNT ${identity.accountId}</body></html>`,
      );
    } else {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(
        `globalThis.fixture = { identity: ${JSON.stringify(identity)}, invoke: Object.freeze({${names.map((name) => `${name}: (payload) => globalThis.fixture_${name}(payload)`).join(',')}}) };`,
      );
    }
  });
  const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error('MANAGED_FIXTURE_PAYLOAD_REFUSED');
    return parsed.data;
  };
  const boundedAccount = (actual: string, expected: string) => {
    if (actual !== expected)
      throw new Error('MANAGED_FIXTURE_ACCOUNT_UNPROVEN');
  };
  const protection = (raw: unknown) => {
    const value = parse(protectionOrderSchema, raw);
    return {
      ...value,
      error: value.error === null ? null : 'PROVIDER_UNCERTAIN',
    };
  };
  const entry = (raw: unknown) => {
    const value = parse(resultSchema, raw);
    return {
      ...value,
      error:
        value.error === null
          ? null
          : value.status === 'REJECTED'
            ? 'ENTRY_REJECTED'
            : 'PROVIDER_UNCERTAIN',
    };
  };
  async function handle(
    accountId: string,
    operation: Operation,
    input: unknown,
  ): Promise<unknown> {
    active(accountId, writeOperations.has(operation));
    const provider = mock as MockVestAdapter & {
      addOwnedPosition(request: OwnedMutationRequest): Promise<unknown>;
      reduceOwnedPosition(request: OwnedMutationRequest): Promise<unknown>;
      closeOwnedPosition(request: OwnedMutationRequest): Promise<unknown>;
      changeOwnedProtection(request: OwnedMutationRequest): Promise<unknown>;
      readOwnedMutation(requestId: string): Promise<unknown>;
    };
    switch (operation) {
      case 'readAccounts':
        parse(empty, input);
        return parse(z.array(accountSchema), await mock.listAccounts());
      case 'readQuote':
        parse(empty, input);
        return parse(quoteSchema, await mock.getQuote());
      case 'readAccount':
      case 'readPositions': {
        const payload = parse(ref, input);
        boundedAccount(payload.accountId, accountId);
        const value = parse(
          accountSchema,
          await mock.getAccountState(accountId),
        );
        boundedAccount(value.accountId, accountId);
        return operation === 'readPositions'
          ? parse(z.array(positionSchema), value.positions)
          : value;
      }
      case 'readOrders': {
        const payload = parse(ref, input);
        boundedAccount(payload.accountId, accountId);
        const orders = await mock.getOpenOrders(accountId);
        return orders.map((raw) => {
          const order = protection(raw);
          boundedAccount(order.accountId, accountId);
          return order;
        });
      }
      case 'submitEntry': {
        const request = parse(bridgePayloadSchemas.ENTRY, input);
        boundedAccount(request.accountId, accountId);
        const old = entries.get(request.requestId);
        if (old && old !== accountId)
          throw new Error('MANAGED_FIXTURE_ACCOUNT_UNPROVEN');
        entries.set(request.requestId, accountId);
        const value = entry(await mock.placeOrder(request));
        boundedAccount(value.accountId, accountId);
        return value;
      }
      case 'readEntry': {
        const payload = parse(
          z.object({ requestId: z.string().min(1).max(100) }).strict(),
          input,
        );
        if (entries.get(payload.requestId) !== accountId)
          throw new Error('MANAGED_FIXTURE_ACCOUNT_UNPROVEN');
        const value = await mock.getOrder(payload.requestId);
        return value === null ? null : entry(value);
      }
      case 'submitStop':
      case 'submitTarget': {
        const request = parse(protectionRequestSchema, input);
        boundedAccount(request.accountId, accountId);
        if (
          request.type !==
          (operation === 'submitStop' ? 'STOP_LOSS' : 'TAKE_PROFIT')
        )
          throw new Error('MANAGED_FIXTURE_PAYLOAD_REFUSED');
        return protection(await mock.placeProtectionOrder(request));
      }
      case 'readProtection':
      case 'cancelOrder': {
        const payload = parse(orderRef, input);
        boundedAccount(payload.accountId, accountId);
        if (operation === 'cancelOrder') {
          await mock.cancelOrder(accountId, payload.orderId);
          return null;
        }
        const value = await mock.getProtectionOrder(accountId, payload.orderId);
        return value === null ? null : protection(value);
      }
      case 'flattenOwnedPosition': {
        const payload = parse(
          z
            .object({
              accountId: accountIdSchema,
              entryRequestId: z.string().min(1).max(100),
              expectedRevision: z.number().int().nonnegative(),
            })
            .strict(),
          input,
        );
        boundedAccount(payload.accountId, accountId);
        await mock.flattenOwnedPosition(payload);
        return null;
      }
      case 'repairOwnedProtection': {
        const payload = parse(
          z
            .object({
              request: protectionRequestSchema,
              expectedRevision: z.number().int().nonnegative(),
            })
            .strict(),
          input,
        );
        boundedAccount(payload.request.accountId, accountId);
        return protection(
          await mock.repairOwnedProtection(
            payload.request,
            payload.expectedRevision,
          ),
        );
      }
      case 'readOwnedMutation': {
        const payload = parse(
          z.object({ requestId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
          input,
        );
        if (mutations.get(payload.requestId) !== accountId)
          throw new Error('MANAGED_FIXTURE_ACCOUNT_UNPROVEN');
        const value = await provider.readOwnedMutation(payload.requestId);
        return value === null ? null : parse(ownedMutationReceiptSchema, value);
      }
      default: {
        const request = parse(ownedMutationRequestSchema, input);
        boundedAccount(request.accountId, accountId);
        const expected =
          operation === 'addOwnedPosition'
            ? 'ADD'
            : operation === 'reduceOwnedPosition'
              ? 'REDUCE'
              : operation === 'closeOwnedPosition'
                ? 'CLOSE'
                : null;
        if (
          expected
            ? request.operation !== expected
            : !['STOP_CHANGED', 'TARGET_CHANGED'].includes(request.operation)
        )
          throw new Error('MANAGED_FIXTURE_PAYLOAD_REFUSED');
        const old = mutations.get(request.requestId);
        if (old && old !== accountId)
          throw new Error('MANAGED_FIXTURE_ACCOUNT_UNPROVEN');
        mutations.set(request.requestId, accountId);
        const value =
          operation === 'addOwnedPosition'
            ? await provider.addOwnedPosition(request)
            : operation === 'reduceOwnedPosition'
              ? await provider.reduceOwnedPosition(request)
              : operation === 'closeOwnedPosition'
                ? await provider.closeOwnedPosition(request)
                : await provider.changeOwnedProtection(request);
        return parse(ownedMutationReceiptSchema, value);
      }
    }
  }
  async function call<T>(
    accountIdInput: string,
    operation: Operation,
    payload: unknown,
  ): Promise<T> {
    const accountId = parse(accountIdSchema, accountIdInput);
    const previous = lanes.get(accountId) ?? Promise.resolve();
    const run = previous.then(async () => {
      active(accountId, writeOperations.has(operation));
      const page = await pageIdentity(accountId);
      const invocation = {
        id: randomUUID(),
        operation,
        payloadHash: hash(payload),
        claimed: false,
        replied: false,
        reply: undefined as unknown,
      };
      invocations.set(accountId, invocation);
      try {
        const result = await page.evaluate(
          ({ operation, payload }) =>
            (globalThis as unknown as FixtureWindow).fixture.invoke[operation]!(
              payload,
            ),
          { operation, payload: { id: invocation.id, payload } },
        );
        await pageIdentity(accountId);
        if (
          !invocation.claimed ||
          !invocation.replied ||
          hash(result) !== hash(invocation.reply)
        ) {
          emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', accountId);
          throw new Error('MANAGED_FIXTURE_REPLY_UNPROVEN');
        }
        return result as T;
      } catch {
        throw new Error('MANAGED_FIXTURE_OPERATION_UNCONFIRMED');
      } finally {
        if (invocations.get(accountId) === invocation)
          invocations.delete(accountId);
      }
    });
    const tail = run
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        await Promise.allSettled([...(pending.get(accountId) ?? [])]);
      });
    lanes.set(accountId, tail);
    void tail.then(() => {
      if (lanes.get(accountId) === tail) lanes.delete(accountId);
    });
    return run;
  }
  try {
    await mock.connect();
    const accounts = await mock.listAccounts();
    for (const account of accounts)
      identities.set(account.accountId, {
        accountId: account.accountId,
        contextId: randomUUID(),
        generation,
        environment: 'OFFLINE_FIXTURE',
        evidence: 'SYNTHETIC',
      });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(persistentNamespaceProfile ? 43127 : 0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('MANAGED_FIXTURE_LAUNCH_REFUSED');
    origin = 'http://127.0.0.1:' + address.port;
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      serviceWorkers: 'block',
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--no-default-browser-check',
      ],
    });
    context.on('close', () => {
      if (!closing) emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', null);
    });
    context.on('page', () => {
      if (!provisioning && !closing)
        emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', null);
    });
    for (const page of context.pages()) await page.close();
    context.browser()?.on('disconnected', () => {
      if (!closing) emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', null);
    });
    await context.route('**/*', async (route) => {
      const actual = route.request().url();
      let headerNamesProven = false;
      try {
        headerNamesProven = !Object.keys(
          await route.request().allHeaders(),
        ).some((name) => /^(?:proxy-)?authorization$/i.test(name));
      } catch {
        /* A failed header read refuses the request. */
      }
      const allowed =
        headerNamesProven &&
        route.request().method() === 'GET' &&
        [...identities.values()].some(
          (value) =>
            actual === `${origin}/context/${value.contextId}` ||
            actual === `${origin}/fixture/${value.contextId}.js`,
        );
      if (!allowed) {
        blockedRequests++;
        emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', null);
        await route.abort();
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/*', (socket) => {
      blockedRequests++;
      emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', null);
      socket.close();
    });
    for (const [accountId, identity] of identities) {
      const page = await context.newPage();
      pages.set(accountId, page);
      page.on('close', () => {
        if (!closing)
          emit(
            accountId === '01' ? 'GLOBAL' : 'ACCOUNT',
            'CONTEXT_LOST',
            accountId,
          );
      });
      page.on('crash', () => {
        if (!closing)
          emit(
            accountId === '01' ? 'GLOBAL' : 'ACCOUNT',
            'CONTEXT_LOST',
            accountId,
          );
      });
      page.on('framenavigated', (frame) => {
        if (
          frame === page.mainFrame() &&
          frame.url() !== `${origin}/context/${identity.contextId}`
        )
          emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', accountId);
      });
      for (const operation of names)
        await page.exposeBinding(
          `fixture_${operation}`,
          async (source, payload: unknown) => {
            if (source.page !== page || source.frame !== page.mainFrame()) {
              emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', accountId);
              throw new Error('MANAGED_FIXTURE_BINDING_REFUSED');
            }
            await pageIdentity(accountId);
            const envelope = parse(invocationSchema, payload),
              invocation = invocations.get(accountId);
            if (
              !invocation ||
              invocation.id !== envelope.id ||
              invocation.operation !== operation ||
              invocation.payloadHash !== hash(envelope.payload) ||
              invocation.claimed
            ) {
              emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', accountId);
              throw new Error('MANAGED_FIXTURE_INVOCATION_REFUSED');
            }
            invocation.claimed = true;
            const task = handle(accountId, operation, envelope.payload),
              tasks = pending.get(accountId) ?? new Set<Promise<unknown>>();
            tasks.add(task);
            pending.set(accountId, tasks);
            try {
              const value = await task;
              await pageIdentity(accountId);
              invocation.reply = value;
              invocation.replied = true;
              return value;
            } catch {
              throw new Error('MANAGED_FIXTURE_PROVIDER_UNCONFIRMED');
            } finally {
              tasks.delete(task);
            }
          },
        );
      await page.goto(`${origin}/context/${identity.contextId}`);
      await pageIdentity(accountId);
    }
    provisioning = false;
  } catch {
    closing = true;
    await context?.close().catch(() => {});
    await mock.disconnect().catch(() => {});
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!persistentNamespaceProfile)
      rmSync(profile, { recursive: true, force: true });
    throw new Error('MANAGED_FIXTURE_LAUNCH_REFUSED');
  }
  const close = async () => {
    if (closing) return;
    closing = true;
    armed = false;
    state = 'CLOSED';
    emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', null);
    await Promise.allSettled([...lanes.values()]);
    let browserClosed = false;
    try {
      await context!.close();
      browserClosed = true;
    } catch {
      /* Closure remains unconfirmed. */
    }
    let cleanupConfirmed = true;
    try {
      await mock.disconnect();
    } catch {
      cleanupConfirmed = false;
    }
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch {
      cleanupConfirmed = false;
    }
    if (!browserClosed || !cleanupConfirmed)
      throw new Error('MANAGED_FIXTURE_CLOSE_UNCONFIRMED');
    if (!persistentNamespaceProfile)
      rmSync(profile, { recursive: true, force: true });
  };
  const adapter = {
    name: 'ManagedBrowser:OFFLINE_FIXTURE',
    mode: 'SIMULATION' as const,
    environment: 'OFFLINE_FIXTURE' as const,
    scheduling: 'ACCOUNT_LANES' as const,
    connect: async () => {
      await pageIdentity('01');
    },
    disconnect: close,
    listAccounts: () =>
      call<z.infer<typeof accountSchema>[]>('01', 'readAccounts', {}),
    getAccountState: (accountId: string) =>
      call<z.infer<typeof accountSchema>>(accountId, 'readAccount', {
        accountId,
      }),
    getQuote: () => call<z.infer<typeof quoteSchema>>('01', 'readQuote', {}),
    placeOrder: (request: OrderRequest) =>
      call<z.infer<typeof resultSchema>>(
        request.accountId,
        'submitEntry',
        request,
      ),
    getOrder: (requestId: string) => {
      const accountId = entries.get(requestId);
      if (!accountId) return Promise.resolve(null);
      return call<z.infer<typeof resultSchema> | null>(accountId, 'readEntry', {
        requestId,
      });
    },
    placeProtectionOrder: (request: ProtectionRequest) =>
      call<z.infer<typeof protectionOrderSchema>>(
        request.accountId,
        request.type === 'STOP_LOSS' ? 'submitStop' : 'submitTarget',
        request,
      ),
    getProtectionOrder: (accountId: string, orderId: string) =>
      call<z.infer<typeof protectionOrderSchema> | null>(
        accountId,
        'readProtection',
        { accountId, orderId },
      ),
    getOpenOrders: (accountId: string) =>
      call<z.infer<typeof protectionOrderSchema>[]>(accountId, 'readOrders', {
        accountId,
      }),
    cancelOrder: async (accountId: string, orderId: string) => {
      await call(accountId, 'cancelOrder', { accountId, orderId });
    },
    flattenAccount: async (accountId: string): Promise<void> => {
      parse(accountIdSchema, accountId);
      throw new Error('MANAGED_FIXTURE_OWNERSHIP_REQUIRED');
    },
    flattenOwnedPosition: async (scope: {
      accountId: string;
      entryRequestId: string;
      expectedRevision: number;
    }) => {
      await call(scope.accountId, 'flattenOwnedPosition', scope);
    },
    repairOwnedProtection: (
      request: ProtectionRequest,
      expectedRevision: number,
    ) =>
      call<z.infer<typeof protectionOrderSchema>>(
        request.accountId,
        'repairOwnedProtection',
        { request, expectedRevision },
      ),
    addOwnedPosition: (request: OwnedMutationRequest & { operation: 'ADD' }) =>
      call<z.infer<typeof ownedMutationReceiptSchema>>(
        request.accountId,
        'addOwnedPosition',
        request,
      ),
    reduceOwnedPosition: (
      request: OwnedMutationRequest & { operation: 'REDUCE' },
    ) =>
      call<z.infer<typeof ownedMutationReceiptSchema>>(
        request.accountId,
        'reduceOwnedPosition',
        request,
      ),
    closeOwnedPosition: (
      request: OwnedMutationRequest & { operation: 'CLOSE' },
    ) =>
      call<z.infer<typeof ownedMutationReceiptSchema>>(
        request.accountId,
        'closeOwnedPosition',
        request,
      ),
    changeOwnedProtection: (
      request: OwnedMutationRequest & {
        operation: 'STOP_CHANGED' | 'TARGET_CHANGED';
      },
    ) =>
      call<z.infer<typeof ownedMutationReceiptSchema>>(
        request.accountId,
        'changeOwnedProtection',
        request,
      ),
    readOwnedMutation: (requestId: string) => {
      const accountId = mutations.get(requestId);
      if (!accountId) return Promise.resolve(null);
      return call<z.infer<typeof ownedMutationReceiptSchema> | null>(
        accountId,
        'readOwnedMutation',
        { requestId },
      );
    },
  };
  return {
    adapter,
    async armFixture() {
      if (state !== 'READY' || closing || unavailable.size)
        throw new Error('MANAGED_FIXTURE_ARM_REFUSED');
      const revision = ++armRevision;
      armed = false;
      for (const accountId of identities.keys()) await pageIdentity(accountId);
      if (
        revision !== armRevision ||
        state !== 'READY' ||
        unavailable.size ||
        closing
      )
        throw new Error('MANAGED_FIXTURE_ARM_REFUSED');
      armed = true;
    },
    lock: () => {
      armed = false;
      armRevision++;
    },
    close,
    subscribeLifecycle(listener: (event: ManagedFixtureLifecycle) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    inspect: () => ({
      environment: 'OFFLINE_FIXTURE' as const,
      evidence: 'SYNTHETIC' as const,
      generation,
      session: armed ? 'ARMED' : 'LOCKED',
      state,
      blockedRequests,
      contexts: [...identities.values()].map((identity) => ({
        ...identity,
        ready: state === 'READY' && !unavailable.has(identity.accountId),
      })),
    }),
    async exerciseFault(
      accountId: string,
      fault:
        | 'CLOSE_PAGE'
        | 'IDENTITY_CHANGE'
        | 'UNEXPECTED_NAVIGATION'
        | 'UNAPPROVED_REQUEST',
    ) {
      if (
        ![
          'CLOSE_PAGE',
          'IDENTITY_CHANGE',
          'UNEXPECTED_NAVIGATION',
          'UNAPPROVED_REQUEST',
        ].includes(fault)
      )
        throw new Error('MANAGED_FIXTURE_FAULT_REFUSED');
      const page = await pageIdentity(accountId);
      if (fault === 'CLOSE_PAGE') await page.close();
      else if (fault === 'IDENTITY_CHANGE') {
        await page.evaluate(() => {
          (globalThis as unknown as FixtureWindow).fixture.identity.accountId =
            '10';
        });
        await pageIdentity(accountId);
      } else if (fault === 'UNEXPECTED_NAVIGATION') {
        await page.goto('about:blank');
        emit('GLOBAL', 'CHANNEL_INTEGRITY_LOST', accountId);
      } else {
        await page.evaluate(() => {
          const image = (
            globalThis as unknown as {
              document: { createElement(tag: string): { src: string } };
              location: { href: string };
            }
          ).document.createElement('img');
          image.src = new URL(
            '/unapproved-fixture-path',
            (globalThis as unknown as { location: { href: string } }).location
              .href,
          ).href;
        });
      }
    },
  };
}
