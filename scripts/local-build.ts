import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import {
  assertInertModule,
  auditRepository,
  hash,
  policyFiles,
  readRegular,
  verifyArtifact,
} from './security-policy.ts';

export function buildLocalTrading(root: string, output: string): void {
  auditRepository(root);
  const target = resolve(output);
  mkdirSync(target, { recursive: true });
  if (realpathSync(target) !== target)
    throw new Error('OUTPUT_SYMLINK_FORBIDDEN');
  // Never merge a new build into an existing directory or silently remove files.
  if (readdirSync(target).length) throw new Error('BUILD_DIRECTORY_NOT_EMPTY');
  const source = readRegular(root, 'apps/local-trading/index.ts');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ES2022,
      removeComments: true,
    },
  });
  assertInertModule(result.outputText, true);
  const files: Record<string, string> = { 'index.js': result.outputText };
  for (const name of policyFiles)
    files[name] = readRegular(root, `security/${name}`);
  const hashes = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((name) => [name, hash(files[name]!)]),
  );
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(target, name), content, { flag: 'wx' });
  writeFileSync(
    join(target, 'manifest.json'),
    JSON.stringify(
      { version: 1, mode: 'LOCKED_OFFLINE_ONLY', hashes },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  verifyArtifact(target);
}
