# Standalone simulator shell

A minimal harness for running `openstoa-mobile` in an iOS/Android
simulator without booting the full ZKProofport host app. **Simulator
testing only — do not ship this as a separate App Store / Play Store
listing.**

## What's here

- `App.tsx` — drop-in entry component that mounts `<OpenStoaApp />`
  inside a `<HostProvider>` whose host implementation is a minimal
  mock that hits `/api/auth/dev-login` on staging.

## How to run

This shell does not yet include its own RN project scaffolding. To
preview it, copy `App.tsx` into a fresh RN project (e.g.
`npx react-native init OpenStoaShell`) and add the following deps to
that project:

```json
{
  "dependencies": {
    "openstoa-mobile": "file:../path/to/openstoa/packages/mobile",
    "@openstoa/miniapp-bridge": "file:../path/to/openstoa/packages/miniapp-bridge",
    "@openstoa/api-types": "file:../path/to/openstoa/packages/api-types",
    "@react-navigation/native": ">=7",
    "@react-navigation/native-stack": ">=7",
    "@react-navigation/bottom-tabs": ">=7",
    "react-native-safe-area-context": "*",
    "react-native-screens": "*",
    "react-native-sse": "^1.2.1",
    "@tanstack/react-query": "^5",
    "zustand": "^4"
  }
}
```

Then point that project's Metro `watchFolders` at `openstoa/packages/*`
the same way `proofport-app/metro.config.js` does.

## Why no full RN scaffold here?

Doing it inside this directory would commit thousands of lines of
generated iOS/Android boilerplate to the repo for very little gain.
The future plan, when the standalone path becomes meaningful, is to
spin up a separate `openstoa-app/` repo (still consuming this same
`openstoa-mobile` package via `file:` or git URL).

## Limitations of the mock host

- `generateProof` throws — no mopro in this shell.
- `exitToHost` is a no-op.
- `loginToOpenStoa` uses `/api/auth/dev-login` which is **disabled in
  production**. Pointing the shell at production would always fail.
