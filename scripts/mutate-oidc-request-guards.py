#!/usr/bin/env python3
"""Mutation check for the OIDC request binding and relay-request guards.

Each mutation removes one guard, runs the unit tests that are meant to hold
it, and expects at least one failure. The file is restored after every case,
also on Ctrl-C. A mutation whose text is not found is reported as an ERROR,
never as caught: a substitution that matched nothing proves nothing.

Run from the openstoa directory on Node 20 (CI's version):
    python3 scripts/mutate-oidc-request-guards.py
"""
import os
import re
import subprocess
import sys

ROOT = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()

RELAY_TESTS = ['src/__tests__/relay.test.ts']
PROOF_TESTS = ['src/__tests__/trusted-verification.test.ts']
TOPIC_TESTS = ['src/__tests__/topic-proof-boundary.test.ts']
POLL_TESTS = ['src/__tests__/proof-poll-scope.test.ts']
CLI_TESTS = ['src/__tests__/cliLogin.test.ts']
ROUTE_TESTS = ['src/__tests__/topic-proof-scope.test.ts']
AI_TESTS = ['src/__tests__/ai-login-proof-boundary.test.ts']

MUTATIONS = [
    ('relay: unknown circuit is not refused', 'src/lib/relay.ts',
     '  if (!isRelayCircuit(circuit)) {\n    throw new Error(`Unknown circuit',
     '  if (false) {\n    throw new Error(`Unknown circuit', RELAY_TESTS),
    ('relay: unknown APP_ENV falls back to the localhost icon', 'src/lib/relay.ts',
     "    throw new Error(`Unknown APP_ENV '${environment}'. Known: ${Object.keys(DAPP_ICONS).join(', ')}.`);",
     "    return 'http://localhost:3200/icon.png';", RELAY_TESTS),
    ('relay: OIDC request is not recorded', 'src/lib/relay.ts',
     '    await rememberRelayRequest(relay.requestId, { scope, circuit });', '', RELAY_TESTS),
    ('relay: OIDC scope bounds not checked', 'src/lib/relay.ts',
     "  if (circuit === 'oidc_domain_attestation'\n    && (typeof scope",
     "  if (false\n    && (typeof scope", RELAY_TESTS),
    ('proof: mode-1 proof accepted without a request', 'src/lib/proof.ts',
     "    && BigInt(publicInputs[OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT.NONCE_MODE]) !== 0n\n",
     "    && false\n", PROOF_TESTS + AI_TESTS),
    ('proof: request not passed to core', 'src/lib/proof.ts',
     "      known === 'oidc_domain_attestation' && oidcRequest !== undefined ? { request: oidcRequest } : undefined,",
     '      undefined,', PROOF_TESTS),
    ('proof: result.requestId used instead of the polled id', 'src/lib/proof.ts',
     '  const request = { scope: recorded.scope, requestId };',
     '  const request = { scope: recorded.scope, requestId: result.requestId };', PROOF_TESTS),
    ('proof: missing record verified without the request', 'src/lib/proof.ts',
     '  if (!recorded) {\n    return { valid: false, error: `OpenStoa has no record',
     '  if (!recorded) {\n    return verifyTrustedTopicProof(result.circuit, result.proof, inputs, claimed);\n    return { valid: false, error: `OpenStoa has no record', PROOF_TESTS),
    ('proof: record for another circuit accepted', 'src/lib/proof.ts',
     '  if (recorded.circuit !== result.circuit) {', '  if (false) {', PROOF_TESTS),
    ('proof: OIDC count back to v1 (148)', 'src/lib/proof.ts',
     '  oidc_domain_attestation: 214,', '  oidc_domain_attestation: 148,', PROOF_TESTS),
    ('topic gate: kept request not looked up', 'src/lib/topic-proof.ts',
     '        oidcRequest = bound;', '', TOPIC_TESTS),
    ('poll: proof-only OIDC poll keeps no request', 'src/app/api/auth/poll/[requestId]/route.ts',
     '        await rememberBoundOidcProof(result.proof, verification.request);', '', POLL_TESTS),
    ('poll: result id passed instead of the polled id', 'src/app/api/auth/poll/[requestId]/route.ts',
     '    const verification = await verifyProofFromRelay(result, requestId);',
     '    const verification = await verifyProofFromRelay(result, result.requestId);', POLL_TESTS),
    ('cli login: request not passed', 'src/lib/cliLogin.ts',
     ",undefined,{scope:COMMUNITY_SCOPE,requestId:record.requestId!});", ');', CLI_TESTS),
    ('proof-request route: missing circuitType defaults', 'src/app/api/auth/proof-request/route.ts',
     '    if (!isRelayCircuit(circuitType)) {', "    if (circuitType === undefined) circuitType = 'coinbase_attestation';\n    if (!isRelayCircuit(circuitType)) {", ROUTE_TESTS),
    ('ProofGate imports the server relay module again', 'src/components/ProofGate.tsx',
     "      const QRCode = await import('qrcode');",
     "      await import('@/lib/relay');\n      const QRCode = await import('qrcode');", ['src/__tests__/relayIsServerOnly.test.ts']),
]


def run_tests(files):
    env = dict(os.environ)
    env.pop('NODE_OPTIONS', None)
    result = subprocess.run(['npx', 'vitest', 'run', *files], cwd=ROOT, env=env, capture_output=True, text=True)
    return result.returncode, result.stdout + result.stderr


def main():
    caught, missed, errors = 0, [], []
    for name, rel, old, new, tests in MUTATIONS:
        path = os.path.join(ROOT, rel)
        with open(path, encoding='utf8') as f:
            original = f.read()
        if original.count(old) != 1:
            errors.append(f'{name}: expected text found {original.count(old)} times in {rel}')
            print(f'ERROR   {name}', flush=True)
            continue
        try:
            with open(path, 'w', encoding='utf8') as f:
                f.write(original.replace(old, new))
            code, output = run_tests(tests)
        finally:
            with open(path, 'w', encoding='utf8') as f:
                f.write(original)
        # A test that ran and failed. A file broken by the substitution fails
        # to load and runs no tests; that is not a catch.
        if code != 0 and re.search(r'Tests\s+\d+ failed', output):
            caught += 1
            print(f'caught  {name}', flush=True)
        else:
            missed.append(name)
            print(f'MISSED  {name} (exit {code})', flush=True)
    print(f'\n{caught}/{len(MUTATIONS)} caught, {len(missed)} missed, {len(errors)} errors')
    for line in errors:
        print('  ' + line)
    return 0 if not missed and not errors else 1


if __name__ == '__main__':
    sys.exit(main())
