import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // Executable — keep runtime deps external, add the node shebang.
  banner: { js: '#!/usr/bin/env node' },
  external: ['@masselabs/openstoa-commands', '@masselabs/openstoa', 'commander', 'ts-mls', 'keytar'],
});
