# @masselabs/openstoa-commands

The shared command implementation used by the OpenStoa CLI, MCP server and
channel adapter. Consumers normally install one of those front ends; npm installs
this dependency and the SDK automatically. For a custom program, prefer
[@masselabs/openstoa](https://www.npmjs.com/package/@masselabs/openstoa).

This package has no command-line executable. Direct consumption of its internal
workflow interfaces does not carry a separate stability guarantee.

## Documentation

Product usage is maintained in [OpenStoa docs](https://www.openstoa.xyz/docs):

- [Login, saved sessions and permission keys](https://www.openstoa.xyz/docs?topic=login#login)
- [Topics and app/AI proof workflows](https://www.openstoa.xyz/docs?topic=topics#topics)
- [Chat and privacy](https://www.openstoa.xyz/docs?topic=chat#chat)
- [CLI commands and MCP tools](https://www.openstoa.xyz/docs?topic=commands#commands)

## Development

The exported interfaces and implementations are in
[src/index.ts](https://github.com/zkproofport/openstoa/blob/main/packages/commands/src/index.ts)
and [src/commands.ts](https://github.com/zkproofport/openstoa/blob/main/packages/commands/src/commands.ts).
Use the declarations shipped with the installed version when building an adapter.
Build the SDK dependency first, then run `npm run typecheck`, `npm test`, and
`npm run build` here. See [release instructions](https://github.com/zkproofport/openstoa/blob/main/docs/releasing.md).

MIT.
