import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  createVerificationReport,
  validateCatalog,
  type CheckResult,
} from './verification-report.ts';

const root = realpathSync(process.cwd());
const commands = [
  ['security', ['security:check']],
  ['build', ['build:local']],
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['format', ['format:check']],
  [
    'regression',
    [
      'exec',
      'vitest',
      'run',
      '--no-file-parallelism',
      '--silent',
      '--exclude',
      'tests/authorized-live/**',
    ],
  ],
] as const;

function fingerprint(): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  function collect(directory: string): void {
    for (const entry of readdirSync(join(root, directory))) {
      const path = join(directory, entry);
      const metadata = lstatSync(join(root, path));
      if (metadata.isSymbolicLink()) throw new Error('UNSUPPORTED_SOURCE_LINK');
      if (metadata.isDirectory()) collect(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error('UNSUPPORTED_SOURCE_FILE');
    }
  }
  for (const directory of ['apps', 'packages', 'scripts', 'security', 'tests'])
    collect(directory);
  for (const name of readdirSync(root)) {
    if (
      /^(package\.json|pnpm-lock\.yaml|tsconfig.*\.json|eslint\.config\..*|vitest\.config\..*)$/.test(
        name,
      )
    ) {
      if (
        !lstatSync(join(root, name)).isFile() ||
        lstatSync(join(root, name)).isSymbolicLink()
      )
        throw new Error('UNSUPPORTED_CONFIG_FILE');
      files.push(name);
    }
  }
  for (const file of files.sort()) {
    const bytes = readFileSync(join(root, file));
    hash.update(
      JSON.stringify(file.replaceAll('\\', '/')) + ':' + bytes.length + ':',
    );
    hash.update(bytes);
  }
  return hash.digest('hex');
}

async function run(): Promise<void> {
  // Windows cannot execute pnpm.cmd with shell:false. pnpm run supplies the
  // local JavaScript entry; invoke it directly through Node without a shell.
  const pnpmEntry = process.env.npm_execpath;
  if (
    process.platform === 'win32' &&
    (!pnpmEntry ||
      !isAbsolute(pnpmEntry) ||
      !/^pnpm(?:\.[cm]?js)?$/i.test(basename(pnpmEntry)) ||
      !lstatSync(pnpmEntry).isFile())
  )
    throw new Error('PNPM_NODE_ENTRY_REQUIRED');
  const catalog = validateCatalog(
    JSON.parse(
      readFileSync(join(root, 'security/functional-gates.json'), 'utf8'),
    ),
  );
  const before = fingerprint();
  const results: CheckResult[] = [];
  for (const [id, args] of commands) {
    const started = Date.now();
    const exit = await new Promise<0 | 1>((resolveExit) => {
      const child = spawn(
        process.platform === 'win32' ? process.execPath : 'pnpm',
        process.platform === 'win32' ? [pnpmEntry!, ...args] : [...args],
        {
          cwd: root,
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      );
      const timeout = setTimeout(
        () => {
          try {
            if (process.platform !== 'win32' && child.pid)
              process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // Cleanup failures still fail the check; never emit raw errors.
          }
          resolveExit(1);
        },
        id === 'regression' ? 600_000 : 180_000,
      );
      child.on('error', () => {
        clearTimeout(timeout);
        resolveExit(1);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolveExit(code === 0 ? 0 : 1);
      });
    });
    results.push({ id, exit, durationMs: Math.max(0, Date.now() - started) });
    console.log(`${id}: ${exit === 0 ? 'PASS' : 'FAIL'}`);
  }
  const report = createVerificationReport(
    catalog,
    results,
    before,
    fingerprint(),
  );
  const directory = resolve(root, 'dist');
  mkdirSync(directory, { recursive: true });
  if (realpathSync(directory) !== directory)
    throw new Error('REPORT_PATH_ALIAS');
  const output = resolve(directory, `functional-proof-${randomUUID()}`);
  mkdirSync(output);
  if (realpathSync(output) !== output) throw new Error('REPORT_PATH_ALIAS');
  writeFileSync(
    join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    `Local checks ${report.localChecksPassed ? 'PASS' : 'FAIL'}; offlineGatesComplete=${report.offlineGatesComplete}; live LOCKED; functional=false; authorizesLive=false.`,
  );
  for (const gate of report.gates.filter((gate) => gate.status !== 'PASS'))
    console.log(`${gate.id}: ${gate.status}`);
  console.log(`Local report: ${output}/report.json`);
  if (!report.localChecksPassed) process.exitCode = 1;
}

void run().catch(() => {
  console.error('Verification failed closed; no live authorization.');
  process.exitCode = 1;
});
