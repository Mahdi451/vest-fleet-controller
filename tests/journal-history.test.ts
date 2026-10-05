import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Journal } from '../packages/execution/src/journal.ts';

it('preserves historical audit rows across the removal of payout simulation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-audit-history-'));
  const path = join(directory, 'history.sqlite');
  const original = new Journal(path);
  original.halt();
  original.close();
  const legacy = {
    timestamp: 1,
    masterTradeId: 'historical-simulation',
    adapter: 'MockVestAdapter',
    status: 'WITHDRAWAL',
    withdrawalGross: '4',
    withdrawalNet: '3.8',
  };
  try {
    const db = new DatabaseSync(path);
    try {
      db.prepare('INSERT INTO audit(event) VALUES(?)').run(
        JSON.stringify(legacy),
      );
    } finally {
      db.close();
    }
    const reopened = new Journal(path);
    try {
      expect(reopened.halted()).toBe(true);
      expect(reopened.events()).toContainEqual(legacy);
      reopened.log({
        timestamp: 2,
        masterTradeId: 'new-simulation',
        adapter: 'MockVestAdapter',
        status: 'RECONCILED',
      });
    } finally {
      reopened.close();
    }
    const stored = new DatabaseSync(path);
    try {
      expect(
        stored.prepare('SELECT event FROM audit WHERE id=1').get()?.event,
      ).toBe(JSON.stringify(legacy));
    } finally {
      stored.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
