import { z } from 'zod';
import {
  accountSchema,
  quoteSchema,
  protectionOrderSchema,
  type ProtectionRequest,
} from '../../core/src/index.ts';
import {
  resultSchema,
  type OrderRequest,
} from '../../execution/src/adapter.ts';

export const identitySchema = z
  .object({
    accountId: z.string().min(1),
    label: z.string().min(1),
    contextId: z.string().min(1),
  })
  .strict();
export type BrowserAccountIdentity = Readonly<z.infer<typeof identitySchema>>;
export const visibleBookSchema = z
  .object({
    identity: identitySchema,
    observedAt: z.number().int().nonnegative(),
    account: accountSchema,
    inventory: z.array(accountSchema).min(1),
    quote: quoteSchema,
    entries: z.array(resultSchema),
    protection: z.array(protectionOrderSchema),
  })
  .strict();
export type VisibleBook = z.infer<typeof visibleBookSchema>;
export type BrowserAction =
  | { kind: 'ENTRY'; accountId: string; order: OrderRequest }
  | { kind: 'PROTECTION'; accountId: string; order: ProtectionRequest }
  | { kind: 'CANCEL'; accountId: string; orderId: string }
  | { kind: 'FLATTEN'; accountId: string; entryRequestId: string | null };

/** Synthetic visible-DOM contract, NOT discovered Vest selectors or an executable live transport. */
export interface BrowserDom {
  readonly environment: 'LOCAL_FIXTURE';
  readonly contextId: string;
  assertLocalFixture(): Promise<void>;
  selectAccount(identity: BrowserAccountIdentity): Promise<void>;
  readBook(): Promise<unknown>;
  prepare(action: BrowserAction): Promise<void>;
  readPrepared(): Promise<BrowserAction>;
  submitPrepared(): Promise<void>;
  /** Close the local page so pending locator actions cannot continue after timeout. */
  quarantine(): Promise<void>;
  close(): Promise<void>;
}
export type BrowserSessionState =
  | 'DISCONNECTED'
  | 'READY'
  | 'SELECTING_ACCOUNT'
  | 'VERIFYING_ACCOUNT'
  | 'SUBMITTING'
  | 'UNCERTAIN'
  | 'RECOVERY_REQUIRED'
  | 'CLOSED';
