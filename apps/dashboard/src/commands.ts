import { createHash } from 'node:crypto';
import type { FleetPreview } from '../../../packages/execution/src/controller.ts';
import type { CommandEnvelope } from '../../../packages/execution/src/journal.ts';

export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function envelope(
  preview: FleetPreview,
  sessionId: string,
  identity: { ownerId: string; instanceId: string },
  maxAgeMs: number,
): CommandEnvelope {
  const payloadHash = hash({
    ...identity,
    sessionId,
    previewId: preview.previewId,
    intent: preview.intent,
    selected: preview.accounts.map((a) => a.accountId),
  });
  return {
    id: hash(['dashboard', payloadHash]),
    payloadHash,
    ...identity,
    sessionId,
    previewId: preview.previewId,
    selected: preview.accounts.map((a) => a.accountId),
    createdAt: preview.createdAt,
    expiresAt: preview.createdAt + maxAgeMs,
    status: 'PREVIEWED',
  };
}
