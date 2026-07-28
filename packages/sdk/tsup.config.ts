import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node20',
  sourcemap: true,
  // ts-mls (and the optional keytar) stay external — they are declared deps.
  external: ['ts-mls', 'keytar'],
});
