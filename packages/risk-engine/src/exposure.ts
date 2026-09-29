import { D, nonnegative, type TradeIntent } from '../../core/src/index.ts';

// Mandatory project policy. Deliberately absent from user-editable configuration.
export const CROSS_ACCOUNT_HEDGE_GUARD = 'ENABLED' as const;
export interface ExposureIntent {
  readonly symbol: string;
  readonly side: TradeIntent['side'];
}
export interface ExposureAccount {
  readonly accountId: string;
  readonly enabled: boolean;
  readonly positions: readonly (ExposureIntent & {
    readonly quantity: string;
  })[];
}
export interface ExposureViolation {
  readonly ruleId: string;
  readonly code: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly side: TradeIntent['side'];
}
export interface FleetExposureRule {
  readonly id: string;
  evaluate(context: {
    readonly intent: ExposureIntent;
    readonly accounts: readonly ExposureAccount[];
  }): readonly ExposureViolation[];
}

function marketIdentity(symbol: string): string {
  const label = symbol.trim().toUpperCase();
  // Local display aliases only. This is NOT a verified external/API mapping.
  return label === 'NQ' ? 'NDX' : label;
}
const sameMarketDirection: FleetExposureRule = {
  id: 'SAME_MARKET_DIRECTION',
  evaluate: ({ intent, accounts }) =>
    accounts.flatMap((account) =>
      account.positions
        .filter(
          (position) =>
            new D(nonnegative.parse(position.quantity)).gt(0) &&
            marketIdentity(position.symbol) === marketIdentity(intent.symbol) &&
            position.side !== intent.side,
        )
        .map((position) => ({
          ruleId: 'SAME_MARKET_DIRECTION',
          code: 'CROSS_ACCOUNT_HEDGE_GUARD',
          accountId: account.accountId,
          symbol: position.symbol,
          side: position.side,
        })),
    ),
};

/** Entry checks only. Close/flatten operations must never call this pipeline. */
export function evaluateFleetExposure(
  intent: ExposureIntent,
  fleet: readonly ExposureAccount[],
  additionalRules: readonly FleetExposureRule[] = [],
): ExposureViolation[] {
  const accounts = fleet.filter((account) => account.enabled);
  const context = { intent, accounts };
  // Mandatory violations are retained. Extra policies can only add violations.
  const violations = [...sameMarketDirection.evaluate(context)];
  for (const rule of additionalRules)
    violations.push(...rule.evaluate(context));
  return violations;
}
