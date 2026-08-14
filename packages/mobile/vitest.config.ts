import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * `react-test-renderer` and `react` come from the HOST app's install.
 *
 * This package deliberately ships no `node_modules` — consumers pull it via
 * `file:` — so the renderer is borrowed rather than installed. Both are aliased
 * to the SAME copy on purpose: two React instances in one process produce
 * "invalid hook call" from a component that is perfectly correct, which is a
 * long detour for anyone who hits it.
 *
 * ── T-1: what changed when a whole SCREEN had to mount ─────────────────────
 *
 * Rendering one component needed only React. Rendering `ChatRoomScreen` needs
 * its data layer too, and the rule applied here is: EVERYTHING THAT CAN BE REAL
 * IS REAL. `@tanstack/react-query`, `zustand`, `i18next`, `react-i18next`,
 * `react-native-sse` and `@react-navigation/*` are the actual packages. Only
 * the surface that cannot execute off a device is stubbed — `react-native`
 * itself, `react-native-svg`, and the icon font. A screen mounted against ten
 * fakes tests the fakes.
 *
 * Nothing new is installed for this. The split falls out of what `package.json`
 * already declares:
 *   - `dependencies` (react-query, zustand, react-native-sse) are installed
 *     HERE and resolve on their own.
 *   - `peerDependencies` (react, i18next, react-i18next, @react-navigation/*)
 *     come from the host, which is what a peer dependency MEANS. Installing a
 *     second copy of one is not a neutral convenience: react-i18next and
 *     @react-navigation both hold React context, and a duplicate produces a
 *     provider the consumer cannot see — the same class of bug as two Reacts,
 *     with a less obvious error message.
 *
 * ── Why `server.deps.inline` is load-bearing, not tidying ───────────────────
 *
 * Vitest externalises `node_modules` by default, and an externalised module is
 * loaded by Node — which never sees the aliases below. Two consequences, both
 * of which cost real time to find:
 *
 *   1. `@react-navigation/native` imports `react-native`. Externalised, it gets
 *      the REAL one, whose source is Flow-typed, and the run dies with
 *      `SyntaxError: Unexpected token 'typeof'` pointing at nothing recognisable.
 *      Inlined, the stand-in applies and it loads.
 *   2. `zustand` pulls `use-sync-external-store`, which does `require('react')`.
 *      Resolved by Node from this package, that walks UP to
 *      `openstoa/node_modules/react` — a different copy AND a different version
 *      (19.2.x) from the host's (19.1.x) that the renderer drives. The symptom
 *      is `Cannot read properties of null (reading 'useRef')` from a component
 *      that is correct, which reads as a React bug and is not one. The explicit
 *      `use-sync-external-store` aliases below pin it to the same copy as
 *      everything else.
 *
 * `react/jsx-runtime` is aliased for the same reason as `react`: the automatic
 * JSX transform imports it by that specifier, and aliasing only `react` leaves
 * a second copy reachable through the back door.
 */
const HOST_MODULES = path.resolve(__dirname, '../../../proofport-app/node_modules');
const HARNESS = path.resolve(__dirname, 'src/__tests__/harness');

export default defineConfig({
  test: {
    environment: 'node',
    // `.tsx` so components can be rendered, not only logic exercised.
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    setupFiles: ['src/__tests__/harness/setup.ts'],
    /*
     * Everything goes through Vite so the aliases below actually apply. See the
     * header — with the default externalisation, two of these packages resolve
     * a React the renderer is not driving, and the failures name neither the
     * package nor React.
     */
    server: { deps: { inline: true } },
  },
  resolve: {
    /*
     * One React, whatever path leads to it. `dedupe` covers the specifiers Vite
     * resolves; the explicit aliases cover the ones a CJS `require` inside a
     * dependency would otherwise resolve through Node.
     */
    dedupe: ['react', 'react-test-renderer'],
    alias: {
      // Thin stand-ins for the native surface. A screen that reaches for
      // something these do not define fails loudly at import — which is the
      // point: a mock that quietly answers everything hides the change it
      // should have surfaced.
      'react-native-vector-icons/Feather': path.join(HARNESS, 'iconStub.tsx'),
      'react-native-vector-icons/MaterialIcons': path.join(HARNESS, 'iconStub.tsx'),
      'react-native-vector-icons/Ionicons': path.join(HARNESS, 'iconStub.tsx'),
      'react-native-svg': path.join(HARNESS, 'nativeStubs.tsx'),
      'react-native': path.join(HARNESS, 'reactNative.tsx'),
      // Pinned by full specifier because that is exactly how zustand imports
      // them; a prefix alias does not match and the duplicate React returns.
      'use-sync-external-store/shim/with-selector.js': path.join(
        HOST_MODULES,
        'use-sync-external-store/shim/with-selector.js',
      ),
      'use-sync-external-store/shim/index.js': path.join(
        HOST_MODULES,
        'use-sync-external-store/shim/index.js',
      ),
      'react/jsx-runtime': path.join(HOST_MODULES, 'react/jsx-runtime'),
      'react/jsx-dev-runtime': path.join(HOST_MODULES, 'react/jsx-dev-runtime'),
      react: path.join(HOST_MODULES, 'react'),
      'react-test-renderer': path.join(HOST_MODULES, 'react-test-renderer'),
      // Peer dependencies: the host's copies, for the reason in the header.
      'react-i18next': path.join(HOST_MODULES, 'react-i18next'),
      i18next: path.join(HOST_MODULES, 'i18next'),
      '@react-navigation/native': path.join(HOST_MODULES, '@react-navigation/native'),
      // Workspace siblings, from source — they have no build step.
      '@openstoa/miniapp-bridge': path.resolve(__dirname, '../miniapp-bridge/src/index.ts'),
      '@openstoa/api-types': path.resolve(__dirname, '../api-types/src/index.ts'),
    },
  },
});
