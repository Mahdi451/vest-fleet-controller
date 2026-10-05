import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLocalTrading } from './local-build.ts';

mkdirSync(resolve('dist'), { recursive: true });
const output = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(resolve('dist/local-trading-'));
buildLocalTrading(process.cwd(), output);
console.log(`Verified inert local artifact: ${output}`);
