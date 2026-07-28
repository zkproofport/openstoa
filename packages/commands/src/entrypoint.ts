/**
 * Entry-point detection shared by the two executables in this package set
 * (`openstoa` in @masselabs/openstoa-cli, `openstoa-mcp` in
 * @masselabs/openstoa-mcp). Both need to auto-run only when invoked as the
 * process entry, and stay inert when a unit test imports the module.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * True when `moduleUrl` IS the process entry point.
 *
 * `import.meta.url` is always a realpath — Node's ESM loader resolves symlinks
 * before it records a module's URL. `process.argv[1]` is whatever path the
 * shell invoked, and npm installs package bins as symlinks
 * (`<prefix>/bin/openstoa -> ../lib/node_modules/@masselabs/openstoa-cli/dist/
 * cli.js`). Comparing the two raw therefore never matched for a globally
 * installed CLI: `main()` never ran, so `openstoa --help` printed nothing and
 * exited 0. Resolve argv[1] to its realpath before comparing.
 */
export function isEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  let resolved = argvPath;
  try {
    resolved = realpathSync(argvPath);
  } catch {
    // argv[1] may not exist on disk (deleted file, virtual entry) — compare raw.
  }
  return moduleUrl === pathToFileURL(resolved).href;
}
