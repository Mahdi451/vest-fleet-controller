import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import {
  D,
  intentSchema,
  riskConfigSchema,
} from '../../../packages/core/src/index.ts';
import { MockVestAdapter } from '../../../packages/simulator/src/index.ts';
import { FleetController } from '../../../packages/execution/src/controller.ts';
import { Journal } from '../../../packages/execution/src/journal.ts';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'config/example.yaml' },
      price: { type: 'string', default: '30400' },
      side: { type: 'string', default: 'LONG' },
      stop: { type: 'string', default: '80' },
      target: { type: 'string', default: '80' },
      mode: { type: 'string', default: 'PERCENT_DRAWDOWN' },
      risk: { type: 'string', default: '40' },
      leverage: { type: 'string', default: '50' },
      scenario: { type: 'string', default: 'win' },
      json: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (
    !['preview', 'simulate'].includes(command ?? '') ||
    positionals.length !== 1
  )
    throw new Error('Use preview or simulate');
  const config = riskConfigSchema.parse(
    parse(readFileSync(resolve(values.config), 'utf8')),
  );
  const intent = intentSchema.parse({
    symbol: 'NDX',
    entryType: 'MARKET',
    side: values.side,
    stopDistancePoints: values.stop,
    takeProfitPoints: values.target,
    riskMode: values.mode,
    riskValue: values.risk,
    leverage: values.leverage,
  });
  const runId = randomUUID();
  mkdirSync('.runtime', { recursive: true });
  // New simulator run => new ledger. Never imply in-memory balances survive process exit.
  const journal = new Journal(`.runtime/${runId}.sqlite`);
  const adapter = new MockVestAdapter(
    config,
    Date.now,
    undefined,
    values.price,
    (event) => journal.log(event),
  );
  await adapter.connect();
  const controller = new FleetController(adapter, config, journal);
  try {
    const scenarios = [
      'win',
      'loss',
      'partial-failure',
      'ambiguous',
      'timeout',
      'disabled',
      'gap',
      'retry',
    ];
    if (!scenarios.includes(values.scenario))
      throw new Error('Unknown scenario');
    if (values.scenario === 'disabled') adapter.setEnabled('10', false);
    const preview = await controller.preview(intent);
    if (values.json)
      console.log(
        JSON.stringify({ mode: 'SIMULATION_ONLY', ...preview }, null, 2),
      );
    else {
      console.log(
        `SIMULATION ONLY | NQ display / NDX internal | price ${values.price} | ${intent.side} | stop ${intent.stopDistancePoints} | target ${intent.takeProfitPoints} | ${intent.riskMode} ${intent.riskValue}`,
      );
      console.table(
        preview.orders.map((r) => ({
          account: r.accountId,
          drawdown: r.availableDrawdown,
          budget: r.budget,
          units: r.quantity,
          notional: new D(r.notional).toFixed(2),
          stopRisk: new D(r.stopRisk).toFixed(4),
          totalLoss: new D(r.totalPlannedLoss).toFixed(4),
          remaining: new D(r.remainingAfterStop).toFixed(4),
          status: r.approved ? 'APPROVED' : r.reasons.join(','),
        })),
      );
    }
    if (command === 'simulate') {
      if (values.scenario === 'partial-failure')
        adapter.injectFault('08', 'REJECT');
      if (values.scenario === 'ambiguous')
        adapter.injectFault('10', 'AMBIGUOUS_AFTER_FILL');
      if (values.scenario === 'timeout')
        adapter.injectFault('09', 'TIMEOUT_BEFORE_FILL');
      const results = await controller.execute(runId, preview.previewId);
      console.log(JSON.stringify({ execution: results }));
      if (values.scenario === 'retry') {
        const replay = await controller.execute(runId, preview.previewId);
        console.log(
          JSON.stringify({
            replayIsIdentical:
              JSON.stringify(replay) === JSON.stringify(results),
          }),
        );
      }
      const sign = intent.side === 'LONG' ? 1 : -1;
      const move =
        values.scenario === 'loss' || values.scenario === 'gap'
          ? new D(intent.stopDistancePoints)
              .neg()
              .mul(values.scenario === 'gap' ? 5 : 1)
          : new D(intent.takeProfitPoints);
      await adapter.updatePrice(
        new D(
          results.find((r) => r.state === 'PROTECTED')?.entryPrice ??
            values.price,
        )
          .plus(move.mul(sign))
          .toFixed(),
      );
      console.log(
        JSON.stringify(
          {
            accounts: await adapter.listAccounts(),
            emergencyFlatten: await controller.flattenAll(),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await adapter.disconnect();
    journal.close();
  }
}
main().catch(() => {
  console.error(
    'COMMAND_FAILED: check arguments/configuration; no live execution exists.',
  );
  process.exitCode = 1;
});
