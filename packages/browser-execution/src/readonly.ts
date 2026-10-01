import { z } from 'zod';
import { isFresh } from '../../core/src/index.ts';
import {
  assertStableIdentity,
  visibleIdentitySchema,
  visibleInventorySchema,
  visibleObservationSchema,
  type VisibleAccountRef,
} from './observations.ts';

const permissionSchema = z
  .object({
    ownerId: z.string().min(1),
    instanceId: z.string().min(1),
    reference: z.string().min(1),
    scope: z.literal('READ_ONLY_OWNER_ACCOUNTS'),
    approvedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    revoked: z.boolean(),
  })
  .strict();
export type ObservationPermission = z.infer<typeof permissionSchema>;

/** No real port is implemented. Adding one is a separate permission/review gate.
 * These local IDs identify the inspection transport, not the venue account. */
export interface ReadonlyInspectionPort {
  readonly environment: 'OFFLINE_FIXTURE';
  readonly ownerId: string;
  readonly instanceId: string;
  readonly contextId: string;
  readonly pageId: string;
  readInventory(): Promise<unknown>;
  selectAccount(account: Readonly<VisibleAccountRef>): Promise<void>;
  readIdentity(): Promise<unknown>;
  readObservation(): Promise<unknown>;
  quarantine(): Promise<void>;
  close(): Promise<void>;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Read-only scan coordination, not an execution owner, journal or health engine. */
export class SerializedInspectionSession {
  private state: 'UNVERIFIED' | 'OBSERVED' | 'QUARANTINED' | 'CLOSED' =
    'UNVERIFIED';
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: Readonly<{
    timeoutMs: number;
    maxCaptureAgeMs: number;
  }>;
  private readonly permission: Readonly<ObservationPermission> | null;
  private readonly binding: Readonly<{
    ownerId: string;
    instanceId: string;
    contextId: string;
    pageId: string;
  }>;
  constructor(
    private readonly port: ReadonlyInspectionPort,
    permission: ObservationPermission | null,
    options: { timeoutMs: number; maxCaptureAgeMs: number },
    private readonly clock: () => number = Date.now,
  ) {
    if (port.environment !== 'OFFLINE_FIXTURE')
      throw new Error('REAL_OBSERVER_NOT_IMPLEMENTED');
    if (
      !Object.values(options).every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error('INVALID_OBSERVATION_BUDGET');
    this.options = Object.freeze({ ...options });
    this.binding = Object.freeze({
      ownerId: port.ownerId,
      instanceId: port.instanceId,
      contextId: port.contextId,
      pageId: port.pageId,
    });
    this.permission =
      permission === null
        ? null
        : Object.freeze(permissionSchema.parse(permission));
  }
  status() {
    return this.state;
  }
  private usable() {
    if (this.state === 'QUARANTINED' || this.state === 'CLOSED')
      throw new Error('INSPECTION_SESSION_UNUSABLE');
    const p = this.permission;
    if (
      this.port.environment !== 'OFFLINE_FIXTURE' ||
      Object.entries(this.binding).some(
        ([key, value]) => this.port[key as keyof typeof this.binding] !== value,
      )
    )
      throw new Error('INSPECTION_TRANSPORT_CHANGED');
    if (
      !p ||
      p.revoked ||
      p.approvedAt > this.clock() ||
      p.expiresAt <= this.clock()
    )
      throw new Error('OBSERVATION_PERMISSION_REQUIRED');
    if (
      p.ownerId !== this.port.ownerId ||
      p.instanceId !== this.port.instanceId
    )
      throw new Error('OBSERVATION_OWNER_MISMATCH');
  }
  inspect(account: VisibleAccountRef) {
    // Snapshot caller input before queuing; it cannot retarget an in-flight scan.
    const expected = freeze({ ...account });
    const operation = this.queue.then(async () => {
      this.usable(); // Check again when this serialized task begins.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const startedAt = this.clock();
      try {
        const result = await Promise.race([
          this.scan(expected, startedAt),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('INSPECTION_TIMEOUT')),
              this.options.timeoutMs,
            );
          }),
        ]);
        this.usable();
        if (this.clock() - startedAt > this.options.maxCaptureAgeMs)
          throw new Error('SCAN_EXCEEDS_FRESHNESS_BUDGET');
        this.state = 'OBSERVED'; // Says nothing about SAFE, PROTECTED or execution readiness.
        return freeze(result);
      } catch (error) {
        this.state = 'QUARANTINED'; // Late completion and queued scans cannot restore state.
        await this.port.quarantine().catch(() => {});
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async scan(account: VisibleAccountRef, startedAt: number) {
    const checkTransport = (value: { contextId: string; pageId: string }) => {
      this.usable();
      if (
        value.contextId !== this.port.contextId ||
        value.pageId !== this.port.pageId
      )
        throw new Error('INSPECTION_CONTEXT_CHANGED');
    };
    const inventory = visibleInventorySchema.parse(
      await this.port.readInventory(),
    );
    checkTransport(inventory);
    if (
      !inventory.complete ||
      !inventory.accounts.length ||
      !isFresh(inventory.observedAt, this.clock(), this.options.maxCaptureAgeMs)
    )
      throw new Error('INVENTORY_UNAVAILABLE');
    for (const ref of inventory.accounts) assertStableIdentity(ref, ref);
    if (
      new Set(inventory.accounts.map((ref) => ref.visibleId)).size !==
      inventory.accounts.length
    )
      throw new Error('INVENTORY_AMBIGUOUS');
    const selected = inventory.accounts.find(
      (ref) => ref.visibleId === account.visibleId,
    );
    if (!selected) throw new Error('ACCOUNT_NOT_IN_INVENTORY');
    assertStableIdentity(selected, account);
    await this.port.selectAccount(account);
    const selectedAt = this.clock();
    this.usable();
    const before = visibleIdentitySchema.parse(await this.port.readIdentity());
    checkTransport(before);
    assertStableIdentity(before.account, account);
    if (before.session !== 'AUTHENTICATED')
      throw new Error('MANUAL_REAUTHENTICATION_REQUIRED');
    const observation = visibleObservationSchema.parse(
      await this.port.readObservation(),
    );
    checkTransport(observation);
    assertStableIdentity(observation.account, account);
    const after = visibleIdentitySchema.parse(await this.port.readIdentity());
    checkTransport(after);
    assertStableIdentity(after.account, account);
    const endInventory = visibleInventorySchema.parse(
      await this.port.readInventory(),
    );
    checkTransport(endInventory);
    if (
      after.session !== 'AUTHENTICATED' ||
      observation.session !== 'AUTHENTICATED'
    )
      throw new Error('MANUAL_REAUTHENTICATION_REQUIRED');
    if (
      [before, observation, after, endInventory].some(
        (value) => value.uiRevision !== inventory.uiRevision,
      )
    )
      throw new Error('INSPECTION_UI_CHANGED');
    const membership = (refs: VisibleAccountRef[]) =>
      JSON.stringify(
        [...refs].sort((a, b) => a.visibleId!.localeCompare(b.visibleId!)),
      );
    if (
      !endInventory.complete ||
      endInventory.accounts.some((ref) => !ref.visibleId) ||
      membership(endInventory.accounts) !== membership(inventory.accounts)
    )
      throw new Error('INVENTORY_CHANGED');
    if (
      ![
        observation.observedAt,
        endInventory.observedAt,
        inventory.observedAt,
      ].every((time) =>
        isFresh(time, this.clock(), this.options.maxCaptureAgeMs),
      )
    )
      throw new Error('STALE_CAPTURE');
    if (
      inventory.observedAt < startedAt ||
      observation.observedAt < selectedAt ||
      observation.observedAt < inventory.observedAt ||
      endInventory.observedAt < observation.observedAt
    )
      throw new Error('INSPECTION_CHRONOLOGY_UNPROVEN');
    return { observation, inventory, observedThrough: endInventory.observedAt };
  }
  async close() {
    this.state = 'CLOSED';
    await this.queue;
    await this.port.close();
    this.state = 'CLOSED';
  }
}
