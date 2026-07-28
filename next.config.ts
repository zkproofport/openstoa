import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // `@zkproofport-ai/sdk` is used server-side by /api/auth/verify/ai for on-chain
  // proof verification. Keep it external so webpack does not bundle its native/
  // dynamic-require internals into the route chunks.
  // (The former hosted `/mcp` route + its `@zkproofport-ai/mcp` prove.js subprocess
  // and `outputFileTracingIncludes['/mcp']` were removed — the MCP is now the local
  // `@masselabs/openstoa` stdio server under packages/mcp.)
  serverExternalPackages: ['@zkproofport-ai/sdk'],
  async headers() {
    return [
      {
        // AASA must be served as application/json for iOS Associated Domains
        // (webcredentials / passkey). Extensionless /public files default to
        // application/octet-stream, which iOS AASA validation rejects.
        source: '/.well-known/apple-app-site-association',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      },
    ];
  },
};

export default nextConfig;
