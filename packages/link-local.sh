#!/usr/bin/env bash
#
# Bootstrap local resolution for the publishable @masselabs/* packages.
#
# Their inter-package deps are declared as plain semver ("^0.1.0") because
# `file:../sibling` specs are unpublishable — npm would ship a tarball whose
# dependency points at a path that does not exist on the consumer's disk.
#
# Day to day you do NOT need this: each package's committed package-lock.json
# records the sibling as a Link node ("resolved": "../sdk", "link": true), so a
# plain `npm install` in a fresh clone recreates the symlink without asking the
# registry.
#
# This is the repair tool for when that link is lost — lock deleted or
# regenerated from scratch, or a ^0.1.0 spec bumped past the sibling's version.
# It installs each sibling as a --no-save folder link; npm records a Link node
# whose version satisfies the semver edge. Commit the resulting
# package-lock.json afterwards so the next clone stays seamless.
#
# Idempotent — safe to re-run.
#
# Usage:  ./packages/link-local.sh
set -euo pipefail

cd "$(dirname "$0")"

link() {
  local pkg="$1"; shift
  echo "==> $pkg  (linking: $*)"
  ( cd "$pkg" && npm install --no-save --no-audit --no-fund "$@" )
}

# Dependency order: sdk has no @masselabs deps, everything else points back at it.
echo "==> sdk  (no @masselabs deps)"
( cd sdk && npm install --no-audit --no-fund )
link commands ../sdk
link cli      ../sdk ../commands
link mcp      ../sdk ../commands
link channel  ../sdk ../commands

echo
echo "Local links ready. Build in dependency order before running the CLI/MCP:"
echo "  (cd packages/sdk && npm run build) && (cd packages/commands && npm run build) && (cd packages/cli && npm run build)"
