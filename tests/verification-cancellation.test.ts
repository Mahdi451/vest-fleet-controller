import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
function identity(pid: number) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')
      .slice(1)
      .join(') ')
      .trim()
      .split(/\s+/);
    return { started: fields[19]!, alive: fields[0] !== 'Z' };
  } catch {
    return null;
  }
}
function reports() {
  const directory = join(process.cwd(), 'dist');
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.startsWith('functional-proof-'))
        .sort()
    : [];
}
describe('functional verification repeated cancellation', () => {
  it.skipIf(process.platform !== 'linux')(
    'handles two SIGINT signals without orphaning checks or publishing proof',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'verification-cancellation-'));
      const commands = join(root, 'commands.jsonl'),
        pids = join(root, 'pids.json'),
        ready = join(root, 'ready');
      const fake = join(root, 'pnpm');
      writeFileSync(
        fake,
        `#!/usr/bin/env node
const fs=require('node:fs');const {spawn}=require('node:child_process');
fs.appendFileSync(process.env.VERIFICATION_TEST_COMMANDS,JSON.stringify(process.argv.slice(2))+'\\n');
const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.VERIFICATION_TEST_READY,'ready');setInterval(()=>{},1000)"],{stdio:'ignore',env:process.env});
fs.writeFileSync(process.env.VERIFICATION_TEST_PIDS,JSON.stringify([process.pid,grandchild.pid]));
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`,
        { mode: 0o700 },
      );
      const before = reports();
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'scripts/verify-functional.ts'],
        {
          cwd: process.cwd(),
          shell: false,
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            PATH: root + ':' + process.env.PATH,
            VERIFICATION_TEST_COMMANDS: commands,
            VERIFICATION_TEST_PIDS: pids,
            VERIFICATION_TEST_READY: ready,
          },
        },
      );
      const ended = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        child.once('error', () => resolve({ code: null, signal: null }));
      });
      const owned = new Map<number, string>();
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      try {
        await vi.waitFor(
          () => {
            const observed = JSON.parse(readFileSync(pids, 'utf8')) as number[];
            expect(observed).toHaveLength(2);
            for (const pid of observed) {
              const facts = identity(pid);
              expect(facts?.alive).toBe(true);
              owned.set(pid, facts!.started);
            }
            expect(readFileSync(ready, 'utf8')).toBe('ready');
          },
          { timeout: 5000 },
        );
        expect(child.kill('SIGINT')).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(child.kill('SIGINT')).toBe(true);
        const end = await ended;
        expect(end).toEqual({ code: 1, signal: null });
        await vi.waitFor(() =>
          expect(
            [...owned].some(([pid, started]) => {
              const actual = identity(pid);
              return actual?.started === started && actual.alive;
            }),
          ).toBe(false),
        );
        expect(
          readFileSync(commands, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual([['security:check']]);
        expect(reports()).toEqual(before);
      } finally {
        if (!exited && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Owned verifier already stopped. */
          }
        }
        for (const [pid, started] of owned) {
          const actual = identity(pid);
          if (actual?.started === started && actual.alive) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* Already stopped. */
            }
          }
        }
        await ended;
        rmSync(root, { recursive: true, force: true });
      }
    },
    15000,
  );
});
