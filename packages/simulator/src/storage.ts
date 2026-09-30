import { existsSync } from 'node:fs';
import {
  ensurePrivateDirectorySync,
  protectedFileSync,
  publishPrivateFileSync,
  writeExclusivePrivateFileSync,
  removeOwnedPrivateFileSync,
  validateRuntimeFileSync,
} from '../../host/src/storage.ts';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Journal } from '../../execution/src/journal.ts';

/** One local dashboard owner. A crash leaves its lock for deliberate operator recovery. */
export class SimulationStore {
  private lock: string | null = null;
  private owner = JSON.stringify({ pid: process.pid, id: randomUUID() });
  constructor(private readonly directory?: string) {
    if (!directory) return;
    ensurePrivateDirectorySync(directory);
    const path = join(directory, 'controller.lock');
    if (!writeExclusivePrivateFileSync(path, this.owner))
      throw new Error('SIMULATION_STORE_LOCKED');
    this.lock = path;
  }
  open(reset = false) {
    const manifest = this.directory
      ? join(this.directory, 'active-session.json')
      : null;
    if (reset && manifest && existsSync(manifest)) {
      const oldId = z
        .string()
        .uuid()
        .parse(
          JSON.parse(protectedFileSync(manifest).toString('utf8')).sessionId,
        );
      const oldPath = join(this.directory!, `${oldId}.sqlite`);
      if (!existsSync(oldPath)) throw new Error('MISSING_SESSION_JOURNAL');
      validateRuntimeFileSync(oldPath);
      const old = new Journal(oldPath);
      try {
        if (old.hasUnresolvedExecution())
          throw new Error('UNRESOLVED_COMMANDS_PRESERVED');
      } finally {
        old.close();
      }
    }
    const resuming = manifest !== null && existsSync(manifest) && !reset;
    const sessionId = resuming
      ? z
          .string()
          .uuid()
          .parse(
            JSON.parse(protectedFileSync(manifest!).toString('utf8')).sessionId,
          )
      : randomUUID();
    const path = this.directory
      ? join(this.directory, `${sessionId}.sqlite`)
      : ':memory:';
    if (resuming && !existsSync(path))
      throw new Error('MISSING_SESSION_JOURNAL');
    if (resuming) validateRuntimeFileSync(path);
    const newFile = path !== ':memory:' && !existsSync(path);
    // Create a fresh journal with native private permissions before SQLite opens
    // it. Existing journals retain their authoritative contents and permissions.
    if (newFile && !writeExclusivePrivateFileSync(path, ''))
      throw new Error('SESSION_JOURNAL_COLLISION');
    const journal = new Journal(path);
    try {
      const saved = journal.loadSimulator();
      if (saved === null && journal.hasTrades())
        throw new Error('MISSING_SIMULATOR_SNAPSHOT');
      if (manifest && !resuming) {
        publishPrivateFileSync(manifest, JSON.stringify({ sessionId }), true);
      }
      return { journal, sessionId, saved, restored: saved !== null };
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  close() {
    if (this.lock) removeOwnedPrivateFileSync(this.lock, this.owner);
    this.lock = null;
  }
}
