import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { publishPrivateFileSync } from '../../packages/host/src/storage.ts';

export const closeCauseSchema = z.enum([
  'CLI_QUIT',
  'STDIN_EOF',
  'SIGINT',
  'SIGTERM',
  'AUTHORIZATION_EXPIRED',
  'EXTRA_PAGE',
  'UNREVIEWED_NAVIGATION',
  'START_UNVERIFIED',
  'UNEXPECTED_BROWSER_CLOSE',
]);
export type InspectionCloseCause = z.infer<typeof closeCauseSchema>;
const eventSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  elapsedMs: z.number().nonnegative(),
  event: z.enum([
    'LOCK_ACQUIRED',
    'LAUNCH_STARTED',
    'CONTEXT_OPENED',
    'OFFICIAL_START_CONFIRMED',
    'CLOSE_REQUESTED',
    'CONTEXT_CLOSE_OBSERVED',
    'CLOSE_CONFIRMED',
    'CLOSE_UNCONFIRMED_LOCKS_RETAINED',
    'START_FAILED',
  ]),
  state: z.enum([
    'STARTING',
    'OPEN_FOR_MANUAL_SIGN_IN',
    'MANUAL_INSPECTION_ACKNOWLEDGED',
    'QUARANTINED',
    'CLOSED',
  ]),
  cause: closeCauseSchema.nullable(),
  parentPid: z.number().int().positive(),
  platform: z.enum(['linux', 'darwin', 'win32']),
  architecture: z.string().regex(/^[a-z0-9]+$/),
  nodeVersion: z.string().regex(/^v[0-9.]+$/),
  browserVersion: z
    .string()
    .regex(/^[0-9.]+$/)
    .nullable(),
  childExitInformation: z.literal('UNAVAILABLE'),
  closeObserved: z.boolean(),
  closeResult: z.enum(['UNAVAILABLE', 'PENDING', 'RESOLVED', 'REJECTED']),
});
export type LifecycleEvent = z.infer<typeof eventSchema>;
type Observation = Pick<
  LifecycleEvent,
  | 'event'
  | 'state'
  | 'cause'
  | 'browserVersion'
  | 'closeObserved'
  | 'closeResult'
>;

/** A per-run private timeline. Records only fixed lifecycle facts, never browser material.
 * Publishing a growing array preserves event order without reading old profiles/logs. */
export class ObserverLifecycle {
  private readonly runId = randomUUID();
  private readonly started = performance.now();
  private readonly events: LifecycleEvent[] = [];
  private available = true;
  constructor(private readonly directory: string) {}
  record(observation: Observation) {
    try {
      this.events.push(
        eventSchema.parse({
          ...observation,
          version: 1,
          runId: this.runId,
          elapsedMs: performance.now() - this.started,
          parentPid: process.pid,
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version,
          childExitInformation: 'UNAVAILABLE',
        }),
      );
      publishPrivateFileSync(
        join(this.directory, `lifecycle-${this.runId}.json`),
        JSON.stringify(this.events),
        true,
      );
    } catch {
      this.available = false;
    }
    return this.available;
  }
  isAvailable() {
    return this.available;
  }
}
