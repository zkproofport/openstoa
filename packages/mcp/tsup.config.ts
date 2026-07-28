import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['@masselabs/openstoa-commands', '@masselabs/openstoa', '@modelcontextprotocol/sdk', 'zod', 'ts-mls', 'keytar'],
});
