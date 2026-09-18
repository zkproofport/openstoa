import HumanProofPage from '@/components/HumanProofPage';

export const dynamic = 'force-dynamic';
export const metadata = {robots: {index: false, follow: false}};

export default function ProofPage() {
  // Read runtime configuration server-side: Docker's public relay address can
  // differ from the internal RELAY_URL used to create requests. With no custom
  // relay, createSDK() uses the SDK's production relay.
  const runtimeEnv = process.env;
  const relayOrigin = new URL(
    runtimeEnv.NEXT_PUBLIC_RELAY_URL || runtimeEnv.RELAY_URL || 'https://relay.zkproofport.app',
  ).origin;
  return <HumanProofPage relayOrigin={relayOrigin} />;
}
