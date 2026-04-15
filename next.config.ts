import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Prevent webpack from bundling the zkproofport-prove CLI into route chunks.
  // prove.js executes top-level code on import (parses argv, calls process.exit) —
  // bundling it causes the Next.js server to crash on first request. Treat as an
  // external require so it is loaded only when we spawn it as a subprocess.
  serverExternalPackages: ['@zkproofport-ai/mcp', '@zkproofport-ai/sdk'],
  // The CLI is referenced only at runtime via child_process, so the Next.js file
  // tracer cannot detect it statically. Force-include the binaries in the
  // standalone production image.
  outputFileTracingIncludes: {
    '/mcp': [
      './node_modules/@zkproofport-ai/mcp/**/*',
      './node_modules/@zkproofport-ai/sdk/**/*',
      // prove.js (spawned as a subprocess) needs its runtime deps resolvable via
      // standard node resolution, because the MCP SDK is normally bundled into the
      // main Next.js chunks and the standalone output does not carry it in
      // node_modules by default.
      './node_modules/@modelcontextprotocol/sdk/**/*',
      './node_modules/zod/**/*',
      './node_modules/ethers/**/*',
    ],
  },
};

export default nextConfig;
