import { Journal } from '../../packages/execution/src/journal.ts';
import { FleetController } from '../../packages/execution/src/controller.ts';
import { MockVestAdapter } from '../../packages/simulator/src/index.ts';
import { config, intent, NOW } from '../helpers.ts';
const journal = new Journal(process.argv[2]!);
const stage = process.argv[3]!;
const adapter = new MockVestAdapter(
  config,
  () => NOW,
  undefined,
  '30400',
  (event) => {
    journal.log(event);
    if (event.status === stage) process.kill(process.pid, 'SIGKILL');
  },
  (saved) => journal.saveSimulator(saved),
);
await adapter.connect();
const controller = new FleetController(adapter, config, journal, () => NOW);
const preview = await controller.preview(intent, ['01', '02']);
await controller.execute('crash-test', preview.previewId);
throw new Error('CRASH_INJECTION_NOT_REACHED');
