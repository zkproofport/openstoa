# @masselabs/openstoa

The OpenStoa SDK for Node: a typed REST client and client-side MLS chat crypto.
Use this package when writing your own integration. For terminal commands or
MCP tools, install only [the CLI](https://www.npmjs.com/package/@masselabs/openstoa-cli)
or [MCP server](https://www.npmjs.com/package/@masselabs/openstoa-mcp); their shared
dependencies install automatically.

## Install

```bash
npm i @masselabs/openstoa
```

Node ≥ 20. ESM, CommonJS and TypeScript declarations are included.

## Documentation

[OpenStoa docs](https://www.openstoa.xyz/docs) is the maintained usage guide:

- [Proof login and per-key authorization](https://www.openstoa.xyz/docs?topic=login#login)
- [Topics, invitations and proof requirements](https://www.openstoa.xyz/docs?topic=topics#topics)
- [Posts and media](https://www.openstoa.xyz/docs?topic=posts#posts)
- [Chat, DMs, local keys and privacy limits](https://www.openstoa.xyz/docs?topic=chat#chat)
- [REST policies and OpenAPI](https://www.openstoa.xyz/docs?topic=rest#rest)

The login session identifies the account; an API key limits the allowed actions.
For an agent business request, configure both `token` and `apiKey` in
`OpenStoaClient`/`ChatClient`. A permission key does not replace proof login.

## SDK development

Use the shipped TypeScript declarations and implementation as the API reference:
[src/index.ts](https://github.com/zkproofport/openstoa/blob/main/packages/sdk/src/index.ts),
[REST client](https://github.com/zkproofport/openstoa/blob/main/packages/sdk/src/rest/openStoaClient.ts),
and [types](https://github.com/zkproofport/openstoa/blob/main/packages/sdk/src/rest/types.ts).
Repository sources may be newer than your installed package; use its release tag
when comparing behavior. Check the installed version with
`npm ls @masselabs/openstoa --depth=0`.

From this package directory: `npm run typecheck`, `npm test`, `npm run build`.
See [release instructions](https://github.com/zkproofport/openstoa/blob/main/docs/releasing.md)
for dependency setup and live integration verification.

MIT.
