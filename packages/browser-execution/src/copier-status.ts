export const COPIER_CAPABILITIES = [
  'accountReadable',
  'accountSwitchVerified',
  'ticketReadable',
  'leverageControllable',
  'positionReadable',
  'protectionReadable',
  'flattenAvailable',
  'confirmedFlatAvailable',
  'exactlyOnceExecution',
  'reconciliationSupported',
] as const;
export type CopierCapability = (typeof COPIER_CAPABILITIES)[number];
export type CapabilityProof = Record<CopierCapability, boolean>;

export interface SendGate {
  readonly executionProven: boolean;
  readonly liveIntegrationProven: boolean;
  readonly capabilityReady: boolean;
  readonly liveSend: false;
  readonly armed: false;
  readonly sendPermitted: false;
  readonly missing: CopierCapability[];
  readonly haltReason: string | null;
}

/** Dashboard status only. Offline tests do not establish live integration. */
export function evaluateSendGate(
  proven: Partial<CapabilityProof>,
  liveIntegrationProven = false,
): SendGate {
  const missing = COPIER_CAPABILITIES.filter(
    (capability) => proven[capability] !== true,
  );
  const executionProven = missing.length === 0;
  return {
    executionProven,
    liveIntegrationProven,
    capabilityReady: executionProven && liveIntegrationProven,
    liveSend: false,
    armed: false,
    sendPermitted: false,
    missing,
    haltReason: null,
  };
}

export function unprovenCopierStatus(): SendGate {
  return evaluateSendGate({});
}
