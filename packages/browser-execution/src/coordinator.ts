import type { TradeIntent, RiskConfig } from '../../core/src/index.ts';
import {
  FleetController,
  type FleetPreview,
} from '../../execution/src/controller.ts';
import { Journal } from '../../execution/src/journal.ts';
import { BrowserExecutionAdapter } from './adapter.ts';

/** Reuses the existing sequential child lifecycle; does not implement a second risk/protection engine. */
export class SequentialBrowserCoordinator {
  readonly controller: FleetController;
  private busy = false;
  private previews = new Map<string, FleetPreview>();
  constructor(
    readonly adapter: BrowserExecutionAdapter,
    config: RiskConfig,
    private readonly journal: Journal,
    private readonly maxFleetPriceDriftPoints: string = config.maxPriceMovePoints,
    clock: () => number = Date.now,
  ) {
    this.controller = new FleetController(
      adapter,
      config,
      journal,
      clock,
      10000,
    );
  }
  async preview(intent: TradeIntent, accountIds?: string[]) {
    const preview = await this.controller.preview(intent, accountIds);
    this.previews.set(preview.previewId, preview);
    return preview;
  }
  async execute(masterTradeId: string, previewId: string) {
    if (this.busy) throw new Error('BROWSER_FLEET_BUSY');
    this.busy = true;
    const start = performance.now();
    try {
      // Replay through the existing durable master journal before any browser dispatch.
      try {
        return {
          results: this.journal.replay(masterTradeId, previewId),
          replayed: true,
          fanOutMs: 0,
          browser: this.adapter.health(),
        };
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'PREVIEW_NOT_FOUND')
          throw error;
      }
      const preview = this.previews.get(previewId);
      if (!preview) throw new Error('PREVIEW_NOT_FOUND');
      this.adapter.beginFleet(
        masterTradeId,
        preview.quote,
        this.maxFleetPriceDriftPoints,
      );
      const results = await this.controller.execute(masterTradeId, previewId);
      const fanOutMs = performance.now() - start;
      this.journal.log({
        timestamp: Date.now(),
        masterTradeId,
        status: 'BROWSER_FLEET_FINISHED',
        adapter: this.adapter.name,
        latency: fanOutMs,
      });
      return {
        results,
        replayed: false,
        fanOutMs,
        browser: this.adapter.health(),
      };
    } finally {
      this.adapter.endFleet();
      this.busy = false;
    }
  }
  async flattenAll() {
    this.controller.requestHalt();
    // Caller waits for bounded active execution; no concurrent mutable DOM workers.
    if (this.busy) throw new Error('BROWSER_FLEET_BUSY_RETRY_FLATTEN');
    return this.controller.flattenAll();
  }
}
