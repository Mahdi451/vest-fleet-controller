import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultObserverProfile } from './profile.ts';
import { ManualInspectionSession } from './session.ts';

export async function runManualObserver(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      runtime: { type: 'string', default: '.runtime/dashboard' },
      profile: { type: 'string' },
      'authorize-owner-read-only': { type: 'boolean', default: false },
    },
  });
  const session = await ManualInspectionSession.open({
    runtimeDirectory: values.runtime!,
    profileDirectory: values.profile ?? defaultObserverProfile(),
    ownerAuthorizesReadOnly: values['authorize-owner-read-only']!,
  });
  console.log(
    'MANUAL_VEST_OBSERVER_OPEN: sign in directly in the visible Vest browser using normal login/MFA. Do not send credentials here or place orders during this inspection.',
  );
  console.log(
    'Type ready after manual sign-in (acknowledgement only), or quit to close. Account discovery and execution remain unverified and disabled.',
  );
  const input = createInterface({ input: process.stdin });
  const stop = () => {
    void session.close().catch(() => {
      console.error(
        'OBSERVER_CLOSE_UNCONFIRMED: preserve locks and review the browser process.',
      );
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  input.once('close', stop);
  input.on('line', (line) => {
    if (line === 'quit') stop();
    else if (line === 'ready') {
      try {
        session.acknowledgeManualInspection();
        console.log(
          'MANUAL_INSPECTION_ACKNOWLEDGED: account identity, session freshness and evidence still require inspection.',
        );
      } catch {
        console.error('MANUAL_ACKNOWLEDGEMENT_REJECTED');
      }
    } else
      console.log(
        'Use ready or quit. Credentials are entered only in the browser.',
      );
  });
  try {
    await session.whenClosed();
    if (session.status() === 'QUARANTINED') {
      console.error(
        `MANUAL_OBSERVER_QUARANTINED: ${session.stopReason()}. Review browser state and any retained locks before another inspection.`,
      );
      process.exitCode = 1;
    }
  } finally {
    input.removeListener('close', stop);
    input.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runManualObserver(process.argv.slice(2)).catch(() => {
    console.error(
      'MANUAL_OBSERVER_REJECTED: check owner authorization, initialized host, private profile and retained locks. Browser details and authentication data are not logged.',
    );
    process.exitCode = 1;
  });
}
