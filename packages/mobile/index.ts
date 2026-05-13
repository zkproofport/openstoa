// Public surface for proofport-app and the standalone simulator shell.
// Keep small and intentional; everything else stays internal under src/.

export { OpenStoaApp } from './src/OpenStoaApp';
export { OpenStoaTabNavigator } from './src/navigation/OpenStoaTabNavigator';
export { useOpenStoaSession } from './src/stores/sessionStore';

// Re-export the bridge so consumers don't need a separate import.
export {
  HostProvider,
  useHost,
  useHostOptional,
} from '@openstoa/miniapp-bridge';
export type {
  HostApi,
  HostEnvironmentInfo,
  ProofResult,
  ProofInputs,
  AuthResult,
  CircuitId,
} from '@openstoa/miniapp-bridge';
