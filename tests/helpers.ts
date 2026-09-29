import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  initialFleet,
  riskConfigSchema,
  type RiskConfig,
  type TradeIntent,
} from '../packages/core/src/index.ts';
import { MockVestAdapter } from '../packages/simulator/src/index.ts';
import { FleetController } from '../packages/execution/src/controller.ts';
import { Journal } from '../packages/execution/src/journal.ts';
export const NOW = 1_800_000_000_000;
export const config: RiskConfig = riskConfigSchema.parse(
  parse(readFileSync('config/example.yaml', 'utf8')),
);
export const intent: TradeIntent = {
  symbol: 'NDX',
  side: 'LONG',
  entryType: 'MARKET',
  stopDistancePoints: '80',
  takeProfitPoints: '80',
  riskMode: 'PERCENT_DRAWDOWN',
  riskValue: '40',
  leverage: '50',
};
export const quote = { symbol: 'NDX' as const, price: '30400', timestamp: NOW };
export function account(index = 1) {
  return initialFleet(NOW)[index]!;
}
export async function setup(c = config) {
  let now = NOW;
  const clock = () => now;
  const journal = new Journal();
  const adapter = new MockVestAdapter(c, clock, undefined, '30400', (event) =>
    journal.log(event),
  );
  await adapter.connect();
  const controller = new FleetController(adapter, c, journal, clock, 50);
  return {
    adapter,
    journal,
    controller,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
