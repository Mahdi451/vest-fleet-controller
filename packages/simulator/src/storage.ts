import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
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
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'controller.lock');
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch {
      throw new Error('SIMULATION_STORE_LOCKED');
    }
    try {
      writeFileSync(fd, this.owner);
      this.lock = path;
    } finally {
      closeSync(fd);
    }
  }
  open(reset = false) {
    const manifest = this.directory
      ? join(this.directory, 'active-session.json')
      : null;
    const resuming = manifest !== null && existsSync(manifest) && !reset;
    const sessionId = resuming
      ? z
          .string()
          .uuid()
          .parse(JSON.parse(readFileSync(manifest!, 'utf8')).sessionId)
      : randomUUID();
    const path = this.directory
      ? join(this.directory, `${sessionId}.sqlite`)
      : ':memory:';
    if (resuming && !existsSync(path))
      throw new Error('MISSING_SESSION_JOURNAL');
    const journal = new Journal(path);
    try {
      const saved = journal.loadSimulator();
      if (saved === null && journal.hasTrades())
        throw new Error('MISSING_SIMULATOR_SNAPSHOT');
      if (manifest && !resuming) {
        const temporary = `${manifest}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ sessionId }), {
          mode: 0o600,
        });
        renameSync(temporary, manifest);
      }
      return { journal, sessionId, saved, restored: saved !== null };
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  close() {
    if (this.lock && readFileSync(this.lock, 'utf8') === this.owner)
      unlinkSync(this.lock);
    this.lock = null;
  }
}
