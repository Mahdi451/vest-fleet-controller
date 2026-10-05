// This containment artifact is inert. It is not a trading implementation.
export const mode = 'OFFLINE_ONLY';
export const liveState = 'LOCKED';

export function armLiveTrading(): never {
  throw new Error('LIVE_EXECUTION_UNAVAILABLE');
}

export function executeTrade(): never {
  throw new Error('LIVE_EXECUTION_UNAVAILABLE');
}
