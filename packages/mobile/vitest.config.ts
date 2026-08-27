import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { existsSync } from 'node:fs';

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
/*
 * Where `react` and `react-test-renderer` come from.
 *
 * The host app next door is preferred, and that preference is the whole reason
 * this is not a plain devDependency: borrowing its copy is what keeps exactly
 * ONE React in play when the mini-app is loaded through the `file:` symlink.
 *
 * But `proofport-app` is a separate private repository, so a CI runner that
 * checked out `openstoa` alone has no such directory — which is why this job
 * type-checked and never ran a single one of the 1,354 mini-app tests. The
 * fallback is `typecheck/node_modules`: a root that exists for exactly this
 * problem and, deliberately, is NOT on any ancestor path of `src/`, so Metro
 * cannot reach it and the built app still sees one React.
 *
 * NO SILENT THIRD OPTION. If neither exists, this throws by name. Letting the
 * alias point at a path that is not there does not fail — Node resolves `react`
 * the ordinary way instead, and the tests run against a second copy whose hooks
 * belong to a different renderer. That failure reads as a broken test rather
 * than a broken config, which is how it would survive.
 */
function reactModulesDir(): string {
  const host = path.resolve(__dirname, '../../../proofport-app/node_modules');
  const ci = path.resolve(__dirname, 'typecheck/node_modules');
  for (const dir of [host, ci]) {
    if (existsSync(path.join(dir, 'react-test-renderer', 'package.json'))) return dir;
  }
  throw new Error(
    `No react-test-renderer found. Looked in:\n  ${host}\n  ${ci}\n` +
      'Run `npm ci --legacy-peer-deps` in packages/mobile/typecheck, or check out proofport-app next door.',
  );
}

const HOST_MODULES = reactModulesDir();
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
      // Not installed anywhere this workspace's resolution can reach (only the
      // HOST app has it) — see `harness/safeAreaStub.tsx` for why a stub, not
      // a borrowed copy, is the right fix here.
      'react-native-safe-area-context': path.join(HARNESS, 'safeAreaStub.tsx'),
      // Host-only install as well, and worse: the real one runs its work in a
      // Reanimated worklet off a native keyboard observer. See the stub's
      // header for what it can and cannot be asked to prove.
      'react-native-keyboard-controller': path.join(HARNESS, 'keyboardControllerStub.tsx'),
      // Installed in the HOST app only, same as the safe-area stub above. The
      // stub keeps its props so a test can inspect what `PostContent` handed
      // the renderer — read `harness/renderHtmlStub.tsx` for what that does
      // and, more importantly, does not prove.
      'react-native-render-html': path.join(HARNESS, 'renderHtmlStub.tsx'),
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
