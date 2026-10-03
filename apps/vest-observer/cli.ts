import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { EventEmitter } from 'node:events';
import type { InspectionCloseCause } from './lifecycle.ts';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultObserverProfile } from './profile.ts';
import { ManualInspectionSession } from './session.ts';

export function attachObserverControls(
  session: ManualInspectionSession,
  source: Readable = process.stdin,
  signals: Pick<EventEmitter, 'once' | 'removeListener'> = process,
) {
  const input = createInterface({ input: source });
  const stop = (cause: InspectionCloseCause) => {
    void session.close(cause).catch(() => {
      console.error(
        'OBSERVER_CLOSE_UNCONFIRMED: preserve locks and review the browser process.',
      );
    });
  };
  const eof = () => stop('STDIN_EOF');
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  signals.once('SIGINT', interrupt);
  signals.once('SIGTERM', terminate);
  input.once('close', eof);
  input.on('line', (line) => {
    if (line === 'quit') stop('CLI_QUIT');
    else if (line === 'ready') {
      try {
        session.acknowledgeManualInspection();
        console.log(
          'MANUAL_INSPECTION_ACKNOWLEDGED: account identity, session freshness and evidence still require inspection.',
        );
      } catch (error) {
        console.error(
          error instanceof Error && error.message === 'VEST_RETURN_REQUIRED'
            ? 'VEST_RETURN_REQUIRED: return to the Vest page in the browser, then type ready.'
            : 'MANUAL_ACKNOWLEDGEMENT_REJECTED',
        );
      }
    } else
      console.log(
        'Use ready or quit. Credentials are entered only in the browser.',
      );
  });
  return () => {
    input.removeListener('close', eof);
    input.removeAllListeners('line');
    input.close();
    signals.removeListener('SIGINT', interrupt);
    signals.removeListener('SIGTERM', terminate);
  };
}

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
    'Type ready on the Vest page after manual sign-in (acknowledgement only), or quit to close. Quit keeps this browser profile so the next launch can reuse the Vest session. Account discovery and execution remain unverified and disabled.',
  );
  const detach = attachObserverControls(session);
  try {
    await session.whenClosed();
    if (session.status() === 'QUARANTINED') {
      console.error(
        `MANUAL_OBSERVER_QUARANTINED: ${session.stopReason()}. Review browser state and any retained locks before another inspection.`,
      );
      process.exitCode = 1;
    }
  } finally {
    detach();
    if (!session.diagnosticsAvailable())
      console.error('OBSERVER_LIFECYCLE_RECORD_UNAVAILABLE');
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
