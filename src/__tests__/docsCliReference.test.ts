import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CLI_GLOBAL_OPTIONS, CLI_REFERENCE, EXPLICIT_CLI_REFERENCE, GENERATED_CLI_REFERENCE } from '@/lib/docs/cliReference';
import { REST_OPERATIONS } from '../../packages/sdk/src/rest/operations';
import ko from '@/lib/i18n/locales/docs.ko.json';
import en from '@/lib/i18n/locales/docs.en.json';

/** Read the actual Commander declarations without loading network/crypto clients. */
function registeredCommands() {
  const source = ts.createSourceFile('cli.ts', readFileSync(path.resolve('packages/cli/src/cli.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  type Call = { method: string; args: readonly ts.Expression[] };
  function chain(expression: ts.Expression): { root: string; calls: Call[] } {
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const previous = chain(expression.expression.expression);
      return { root: previous.root, calls: [...previous.calls, { method: expression.expression.name.text, args: expression.arguments }] };
    }
    return { root: ts.isIdentifier(expression) ? expression.text : '', calls: [] };
  }
  const literal = (value: ts.Expression | undefined) => value && ts.isStringLiteralLike(value) ? value.text : undefined;
  const groups = new Map<string, string>([['program', '']]);
  const leaves: { name: string; signature: string; flags: string[] }[] = [];
  let globalFlags: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const row = chain(node.initializer);
      const declaration = row.calls.find((call) => call.method === 'command');
      const signature = declaration && literal(declaration.args[0]);
      if (signature && groups.has(row.root)) groups.set(node.name.text, [groups.get(row.root), signature.split(' ')[0]].filter(Boolean).join(' '));
    }
    if (ts.isExpressionStatement(node)) {
      const row = chain(node.expression);
      const declaration = row.calls.find((call) => call.method === 'command');
      const signature = declaration && literal(declaration.args[0]);
      const flags = row.calls.flatMap((call) => {
        if (call.method === 'option' || call.method === 'requiredOption') return literal(call.args[0])?.match(/--[a-z][\w-]*/g) ?? [];
        if (call.method !== 'addOption' || !call.args[0]) return [];
        const option = call.args[0];
        if (chain(option).calls.some((item) => item.method === 'hideHelp')) return [];
        let signature: string | undefined;
        const inspect = (item: ts.Node) => {
          if (ts.isNewExpression(item) && item.expression.getText(source) === 'Option') signature = literal(item.arguments?.[0]);
          ts.forEachChild(item, inspect);
        };
        inspect(option);
        return signature?.match(/--[a-z][\w-]*/g) ?? [];
      });
      if (signature && row.calls.some((call) => call.method === 'action')) {
        const group = groups.get(row.root);
        if (group === undefined) throw new Error(`Undocumented command group ${row.root}`);
        leaves.push({ name: [group, signature.split(' ')[0]].filter(Boolean).join(' '), signature, flags });
      } else if (row.root === 'program' && row.calls.some((call) => call.method === 'name')) globalFlags = flags;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { leaves, globalFlags };
}

describe('CLI documentation contract', () => {
  it('documents every explicitly registered CLI leaf and public option', () => {
    const { leaves, globalFlags } = registeredCommands();
    expect(leaves.length).toBeGreaterThan(30);
    expect(EXPLICIT_CLI_REFERENCE.map((row) => row.command).sort()).toEqual(leaves.map((row) => row.name).sort());
    for (const leaf of leaves) {
      const row = EXPLICIT_CLI_REFERENCE.find((entry) => entry.command === leaf.name)!;
      expect((row.usage.match(/--[a-z][\w-]*/g) ?? []).sort(), leaf.name).toEqual([...leaf.flags].sort());
      for (const argument of leaf.signature.match(/<[^>]+>/g) ?? []) expect(row.usage, leaf.name).toContain(argument);
    }
    expect(CLI_GLOBAL_OPTIONS.join(' ').match(/--[a-z][\w-]*/g)).toEqual(globalFlags);
  });

  it('covers the shared REST registry and requires a reviewed translation for every operation', () => {
    expect(GENERATED_CLI_REFERENCE.map((entry) => entry.command)).toEqual(REST_OPERATIONS.map((operation) => operation.cli.join(' ')));
    expect(new Set(CLI_REFERENCE.map((row) => row.command)).size).toBe(CLI_REFERENCE.length);
    for (const operation of REST_OPERATIONS) {
      expect(GENERATED_CLI_REFERENCE.find((row) => row.command === operation.cli.join(' '))?.access).toBe(operation.availability === 'disabled' ? 'unavailable' : 'agent');
    }
    for (const entry of CLI_REFERENCE) {
      for (const dictionary of [ko, en]) {
        const description = (dictionary as Record<string, string>)[entry.textKey];
        expect(description, entry.command).toBeTypeOf('string');
        expect(description?.trim().length, entry.command).toBeGreaterThan(10);
      }
      expect(['agent', 'owner', 'local', 'unavailable']).toContain(entry.access);
      if (entry.command.startsWith('apikey ')) expect(entry.access).toBe('owner');
    }
  });
  it('keeps unavailable operations explicitly deprecated in generated OpenAPI', () => {
    const spec = JSON.parse(readFileSync(path.resolve('src/generated/openapi-spec.json'), 'utf8'));
    for (const endpoint of ['/api/ask', '/api/ask/stream']) {
      expect(spec.paths[endpoint].post.deprecated).toBe(true);
      expect(Object.keys(spec.paths[endpoint].post.responses)).toEqual(['503']);
    }
  });
});
