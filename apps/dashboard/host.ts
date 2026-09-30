import { createPrivateKey } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { protectFile } from '../../packages/host/src/storage.ts';
import { diagnoseHost } from './src/host-diagnostics.ts';

export async function runHostCommand(args: string[]): Promise<number> {
  const operation = args[0];
  if (operation === 'doctor') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        runtime: { type: 'string', default: '.runtime/dashboard' },
        'private-config': { type: 'string' },
      },
    });
    const result = await diagnoseHost({
      runtimeDirectory: values.runtime!,
      ...(values['private-config']
        ? { privateConfigPath: values['private-config'] }
        : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.preflightPassed ? 0 : 1;
  }
  if (operation === 'protect') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: { path: { type: 'string' } },
    });
    if (!values.path || !/\.(pem|key)$/i.test(values.path))
      throw new Error('TLS_PRIVATE_KEY_PATH_REQUIRED');
    const path = resolve(values.path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
        throw new Error('TLS_PRIVATE_KEY_REQUIRED');
      createPrivateKey(readFileSync(fd)); // No data, passphrases or crypto exceptions are printed.
    } finally {
      closeSync(fd);
    }
    await protectFile(path);
    console.log(
      'TLS private key access protected. Re-run host:doctor before private startup.',
    );
    return 0;
  }
  throw new Error(
    'Use host:doctor --runtime <directory> [--private-config <file>] or host:protect --path <TLS-private-key.pem>',
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runHostCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        'HOST_COMMAND_REJECTED: verify command arguments and native file protection. No runtime records were changed.',
      );
      process.exitCode = 1;
    });
}
