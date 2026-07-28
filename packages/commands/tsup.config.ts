import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // The SDK (and its native deps) stay external — declared runtime deps.
  external: ['@masselabs/openstoa', 'ts-mls', 'keytar'],
});
