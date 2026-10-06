import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runVerificationChild } from '../scripts/verification-child.ts';
function executing(pid: number, started?: string) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
      .split(') ')
      .slice(1)
      .join(') ')
      .trim()
      .split(/\s+/);
    return fields[0] !== 'Z' && (!started || fields[19] === started);
  } catch {
    return false;
  }
}
async function ownedTree(mode: 'ABORT' | 'TIMEOUT', rootResists = false) {
  const root = mkdtempSync(join(tmpdir(), 'verification-owned-tree-'));
  const script = join(root, 'child.cjs'),
    pids = join(root, 'pids.json'),
    ready = join(root, 'ready');
  writeFileSync(
    script,
    `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",process.argv[3]],{stdio:'ignore'});
writeFileSync(process.argv[2],JSON.stringify([process.pid,grandchild.pid]));
process.on('SIGTERM',()=>${rootResists ? '{}' : 'process.exit(0)'});setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  let identities: number[] = [];
  const starts = new Map<number, string>();
  let running: ReturnType<typeof runVerificationChild> | undefined;
  try {
    const result = (running = runVerificationChild({
      command: process.execPath,
      args: [script, pids, ready],
      cwd: root,
      signal: controller.signal,
      timeoutMs: mode === 'TIMEOUT' ? 1000 : 10000,
      killGraceMs: 100,
    }));
    await vi.waitFor(() => {
      identities = JSON.parse(readFileSync(pids, 'utf8')) as number[];
      expect(identities).toHaveLength(2);
      expect(readFileSync(ready, 'utf8')).toBe('ready');
    });
    for (const pid of identities)
      starts.set(
        pid,
        readFileSync(`/proc/${pid}/stat`, 'utf8')
          .split(') ')
          .slice(1)
          .join(') ')
          .trim()
          .split(/\s+/)[19]!,
      );
    expect(identities.every((pid) => executing(pid, starts.get(pid)))).toBe(
      true,
    );
    if (mode === 'ABORT') controller.abort();
    expect(await result).toEqual({ exit: 1, cancelled: true });
    await vi.waitFor(() =>
      expect(identities.some((pid) => executing(pid, starts.get(pid)))).toBe(
        false,
      ),
    );
  } finally {
    controller.abort();
    await running;
    for (const pid of identities) {
      try {
        if (starts.has(pid) && executing(pid, starts.get(pid)))
          process.kill(pid, 'SIGKILL');
      } catch {
        /* Already stopped. */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
describe('background verification child ownership', () => {
  it('returns only normalized results for success, nonzero exit and launch failure', async () => {
    const canary = 'SYNTHETIC_VERIFICATION_ERROR_CANARY';
    expect(
      await runVerificationChild({
        command: process.execPath,
        args: ['-e', `console.log('${canary}');console.error('${canary}');`],
        cwd: process.cwd(),
        timeoutMs: 2000,
      }),
    ).toEqual({ exit: 0, cancelled: false });
    const failure = await runVerificationChild({
      command: process.execPath,
      args: ['-e', `throw new Error('${canary}');`],
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    expect(failure).toEqual({ exit: 1, cancelled: false });
    expect(JSON.stringify(failure)).not.toContain(canary);
    expect(
      await runVerificationChild({
        command: join(tmpdir(), 'nonexistent-verification-command'),
        args: [],
        cwd: process.cwd(),
        timeoutMs: 2000,
      }),
    ).toEqual({ exit: 1, cancelled: false });
  });
  it('does not launch when already aborted or options are invalid', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await runVerificationChild({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        signal: controller.signal,
        timeoutMs: 2000,
      }),
    ).toEqual({ exit: 1, cancelled: true });
    expect(
      await runVerificationChild({
        command: process.execPath,
        args: [],
        cwd: process.cwd(),
        timeoutMs: 0,
      }),
    ).toEqual({ exit: 1, cancelled: false });
  });
  it.skipIf(process.platform !== 'linux').each([false, true])(
    'kills an actual child (root resists TERM: %s) and resistant grandchild after abort',
    async (rootResists) => ownedTree('ABORT', rootResists),
    15000,
  );
  it.skipIf(process.platform !== 'linux')(
    'kills an actual owned child and SIGTERM-resistant grandchild after timeout',
    async () => ownedTree('TIMEOUT'),
    15000,
  );
});
