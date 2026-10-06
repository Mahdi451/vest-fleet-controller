import { spawn } from 'node:child_process';

export type VerificationChildResult = { exit: 0 | 1; cancelled: boolean };
/** Background build/test helper, never a trading runtime capability.
 * POSIX cancellation terminates the owned process group. Windows guarantees only
 * direct-child termination; descendant cleanup needs a reviewed Job Object host.
 */
export function runVerificationChild(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
}): Promise<VerificationChildResult> {
  const failed = { exit: 1, cancelled: false } as const;
  const grace = input.killGraceMs ?? 200;
  if (
    typeof input.command !== 'string' ||
    !input.command ||
    !Array.isArray(input.args) ||
    input.args.some((value) => typeof value !== 'string') ||
    typeof input.cwd !== 'string' ||
    !input.cwd ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 86_400_000 ||
    !Number.isSafeInteger(grace) ||
    grace < 1 ||
    grace > 2000
  )
    return Promise.resolve(failed);
  if (input.signal?.aborted)
    return Promise.resolve({ exit: 1, cancelled: true });
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        detached: posix,
      });
    } catch {
      resolve(failed);
      return;
    }
    let cancelled = false,
      settled = false,
      exited = false,
      escalated = false,
      exitCode: number | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const signalOwned = (signal: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Missing or inaccessible process remains a failed check. */
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      input.signal?.removeEventListener('abort', cancel);
      // A normally exiting test runner must not leave background children either.
      signalOwned('SIGKILL');
      resolve({ exit: !cancelled && exitCode === 0 ? 0 : 1, cancelled });
    };
    const cancel = () => {
      if (cancelled || settled) return;
      cancelled = true;
      signalOwned('SIGTERM');
      graceTimer = setTimeout(() => {
        escalated = true;
        signalOwned('SIGKILL');
        if (exited) finish();
      }, grace);
    };
    const timeout = setTimeout(cancel, input.timeoutMs);
    child.once('error', () => {
      exited = true;
      exitCode = null;
      finish();
    });
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      if (!cancelled || escalated) finish();
    });
    input.signal?.addEventListener('abort', cancel, { once: true });
    // Close the race between the initial signal check and listener registration.
    if (input.signal?.aborted) cancel();
  });
}
