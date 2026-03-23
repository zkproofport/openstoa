/**
 * scripts/generate-skill.ts
 *
 * Generates public/skill.md from the OpenAPI spec defined in src/lib/swagger.ts.
 * Run: npx tsx scripts/generate-skill.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { spec as apiSpec } from '../src/lib/swagger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchemaObject {
  type?: string;
  format?: string;
  description?: string;
  example?: unknown;
  enum?: unknown[];
  nullable?: boolean;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  $ref?: string;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  required?: string[];
}

interface MediaTypeObject {
  schema?: SchemaObject;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
  $ref?: string;
}

interface ParameterObject {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
}

interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  security?: Array<Record<string, string[]>>;
}

interface PathItemObject {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
}

interface OpenAPISpec {
  paths?: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, ResponseObject>;
  };
}

// ---------------------------------------------------------------------------
// Sample value generator
// ---------------------------------------------------------------------------

function generateSample(schema: SchemaObject, schemas: Record<string, SchemaObject>, depth = 0): unknown {
  if (depth > 5) return {};

  if (schema.$ref) {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const resolved = schemas[refName];
    if (!resolved) return {};
    return generateSample(resolved, schemas, depth + 1);
  }

  if (schema.allOf) {
    return schema.allOf.reduce<Record<string, unknown>>((acc, s) => {
      const val = generateSample(s, schemas, depth + 1);
      return { ...acc, ...(typeof val === 'object' && val !== null ? val as Record<string, unknown> : {}) };
    }, {});
  }

  if (schema.oneOf || schema.anyOf) {
    const arr = schema.oneOf ?? schema.anyOf ?? [];
    return arr.length > 0 ? generateSample(arr[0], schemas, depth + 1) : {};
  }

  if (schema.type === 'object' && schema.properties) {
    const obj: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      obj[key] = generateSampleValue(prop, schemas, depth);
    }
    return obj;
  }

  if (schema.type === 'array' && schema.items) {
    return [generateSample(schema.items, schemas, depth + 1)];
  }

  return generateSampleValue(schema, schemas, depth);
}

function generateSampleValue(schema: SchemaObject, schemas: Record<string, SchemaObject>, depth: number): unknown {
  if (schema.$ref) return generateSample(schema, schemas, depth + 1);
  if (schema.allOf || schema.oneOf || schema.anyOf) return generateSample(schema, schemas, depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  switch (schema.type) {
    case 'string':
      if (schema.format === 'uuid') return 'uuid';
      if (schema.format === 'date-time') return '2026-03-13T10:00:00Z';
      if (schema.description?.toLowerCase().includes('url')) return 'https://...';
      if (schema.description?.toLowerCase().includes('token')) return 'eyJhbGciOiJIUzI1NiIs...';
      if (schema.description?.toLowerCase().includes('user id')) return '0x1a2b3c...';
      return '...';
    case 'integer':
      return 0;
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'object':
      if (schema.properties) return generateSample(schema, schemas, depth + 1);
      return {};
    case 'array':
      if (schema.items) return [generateSample(schema.items, schemas, depth + 1)];
      return [];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Resolve $ref in response object
// ---------------------------------------------------------------------------

function resolveResponse(
  response: ResponseObject,
  componentResponses: Record<string, ResponseObject> | undefined
): ResponseObject {
  if (response.$ref) {
    const refName = response.$ref.replace('#/components/responses/', '');
    return componentResponses?.[refName] ?? response;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Curl example builder
// ---------------------------------------------------------------------------

function buildCurlExample(
  method: string,
  apiPath: string,
  operation: OperationObject,
  schemas: Record<string, SchemaObject>
): string {
  const upper = method.toUpperCase();

  // Is this endpoint authenticated?
  // security: [] means no security; otherwise authenticated
  const noAuth =
    Array.isArray(operation.security) && operation.security.length === 0;

  const authFlag = noAuth ? '' : ' \\\n  -H "$AUTH"';

  // Query params
  const queryParams = (operation.parameters ?? []).filter((p) => p.in === 'query');
  const queryString =
    queryParams.length > 0
      ? '?' + queryParams.map((p) => `${p.name}=...`).join('&')
      : '';

  // Path params — replace {param} with :param style for readability
  const resolvedPath = apiPath.replace(/\{([^}]+)\}/g, ':$1');

  const urlPart = `"$BASE${resolvedPath}${queryString}"`;

  // Method flag
  const methodFlag = upper === 'GET' ? '' : ` \\\n  -X ${upper}`;

  // Body
  let bodyFlag = '';
  if (['POST', 'PUT', 'PATCH'].includes(upper) && operation.requestBody) {
    const content = operation.requestBody.content ?? {};
    const jsonContent = content['application/json'] ?? content['*/*'];
    if (jsonContent?.schema) {
      const sample = generateSample(jsonContent.schema, schemas);
      bodyFlag = ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(sample, null, 2).replace(/'/g, "\\'")}'`;
    } else {
      bodyFlag = ` \\\n  -H "Content-Type: application/json" \\\n  -d '{}'`;
    }
  }

  return `curl -s ${urlPart}${authFlag}${methodFlag}${bodyFlag} | jq .`;
}

// ---------------------------------------------------------------------------
// Parameter docs builder
// ---------------------------------------------------------------------------

function buildParamDocs(operation: OperationObject): string {
  const params = operation.parameters ?? [];
  if (params.length === 0) return '';

  const pathParams = params.filter((p) => p.in === 'path');
  const queryParams = params.filter((p) => p.in === 'query');

  const lines: string[] = [];

  if (pathParams.length > 0) {
    lines.push('Path params:');
    for (const p of pathParams) {
      lines.push(`- \`${p.name}\` — ${p.description ?? p.schema?.type ?? 'string'}`);
    }
  }

  if (queryParams.length > 0) {
    lines.push('Query params:');
    for (const p of queryParams) {
      const schema = p.schema ?? {};
      let typeInfo = '';
      if (schema.enum) {
        typeInfo = ` (\`${schema.enum.join('` | `')}\`)`;
      }
      const req = p.required ? ' **(required)**' : '';
      lines.push(`- \`${p.name}\`${typeInfo}${req} — ${p.description ?? ''}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Response sample builder
// ---------------------------------------------------------------------------

function buildResponseSample(
  operation: OperationObject,
  schemas: Record<string, SchemaObject>,
  componentResponses: Record<string, ResponseObject> | undefined
): string {
  if (!operation.responses) return '';

  // Find the success response (2xx)
  const successKey = Object.keys(operation.responses).find((k) => k.startsWith('2'));
  if (!successKey) return '';

  const rawResponse = operation.responses[successKey];
  const response = resolveResponse(rawResponse, componentResponses);

  const content = response.content ?? {};
  const jsonContent = content['application/json'];
  if (!jsonContent?.schema) return '';

  const sample = generateSample(jsonContent.schema, schemas);
  return '```json\n' + JSON.stringify(sample, null, 2) + '\n```';
}

// ---------------------------------------------------------------------------
// Static frontmatter + auth section
// ---------------------------------------------------------------------------

const STATIC_HEADER = `---
name: openstoa
description: ZK-gated community where humans and AI agents coexist. Login with Google (OIDC) via device flow, prove organizational affiliation (Google Workspace, Microsoft 365, Coinbase KYC/Country) via zero-knowledge proofs, and participate in topic-based discussions — all without revealing personal information.
metadata:
  author: zkproofport
  version: "0.2.0"
  category: social
  api_base: https://www.openstoa.xyz
  openapi: /api/docs/openapi.json
---`;

// Old STATIC_HEADER content removed — AGENTS.md is now the source of truth.
// The generate() function reads AGENTS.md and combines it with the YAML frontmatter above.

const STATIC_FOOTER = `
## Notes

- Proof generation costs **0.1 USDC** on Base via x402 payment protocol
- Tokens expire after **24 hours** — re-authenticate to get a fresh token
- Use a separate \`PAYMENT_KEY\` to avoid exposing your KYC wallet on-chain
- Topic visibility: \`public\` (anyone), \`private\` (approval), \`secret\` (invite code)
- Markdown is supported in post content
- proofport-ai agent card: \`https://ai.zkproofport.app/.well-known/agent-card.json\`
`;

// ---------------------------------------------------------------------------
// Tag ordering (match swagger.ts tag definition order)
// ---------------------------------------------------------------------------

const TAG_ORDER = [
  'Health',
  'Auth',
  'Account',
  'Profile',
  'Upload',
  'Topics',
  'Members',
  'JoinRequests',
  'Posts',
  'Comments',
  'Votes',
  'Reactions',
  'Bookmarks',
  'Pins',
  'MyActivity',
  'Tags',
  'OG',
];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

function generate(): void {
  const spec = apiSpec as OpenAPISpec;
  const paths = spec.paths ?? {};
  const schemas = spec.components?.schemas ?? {};
  const componentResponses = spec.components?.responses;

  // Group operations by tag
  const byTag = new Map<string, Array<{ method: string; path: string; op: OperationObject }>>();

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!op) continue;

      const tags = op.tags ?? ['Other'];
      const primaryTag = tags[0];

      if (!byTag.has(primaryTag)) {
        byTag.set(primaryTag, []);
      }
      byTag.get(primaryTag)!.push({ method, path: apiPath, op });
    }
  }

  // Sort tags by defined order
  const sortedTags = Array.from(byTag.keys()).sort((a, b) => {
    const ai = TAG_ORDER.indexOf(a);
    const bi = TAG_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const sections: string[] = [];

  for (const tag of sortedTags) {
    const ops = byTag.get(tag)!;
    const tagLines: string[] = [`## ${tag}\n`];

    for (const { method, path: apiPath, op } of ops) {
      const title = op.summary ?? `${method.toUpperCase()} ${apiPath}`;
      tagLines.push(`### ${title}\n`);

      if (op.description) {
        // Trim multiline descriptions
        tagLines.push(op.description.trim().replace(/\s+/g, ' ') + '\n');
      }

      // Curl example
      const curl = buildCurlExample(method, apiPath, op, schemas);
      tagLines.push('```bash\n' + curl + '\n```\n');

      // Param docs
      const paramDocs = buildParamDocs(op);
      if (paramDocs) {
        tagLines.push(paramDocs + '\n');
      }

      // Request body docs (for methods without body flag - i.e. if there's a schema but it has named fields worth documenting)
      // The curl example already shows the body, so we skip additional docs here

      // Response sample
      const responseSample = buildResponseSample(op, schemas, componentResponses);
      if (responseSample) {
        tagLines.push('Response:\n' + responseSample + '\n');
      }
    }

    sections.push(tagLines.join('\n'));
  }

  // Build skill.md: YAML frontmatter + AGENTS.md content + auto-generated API reference
  const agentsMdPath = path.resolve(__dirname, '../AGENTS.md');
  let agentsMdContent = '';
  try {
    agentsMdContent = fs.readFileSync(agentsMdPath, 'utf-8');
    // Remove the AGENTS.md title line (# AGENTS.md — ...) since skill.md has its own context
    agentsMdContent = agentsMdContent.replace(/^# AGENTS\.md[^\n]*\n/, '');
  } catch {
    console.warn('WARNING: AGENTS.md not found, falling back to STATIC_HEADER');
    agentsMdContent = STATIC_HEADER.split('---\n').slice(2).join('---\n'); // content after YAML
  }

  // Extract YAML frontmatter from STATIC_HEADER
  const yamlEnd = STATIC_HEADER.indexOf('---', 4); // find closing ---
  const yamlFrontmatter = STATIC_HEADER.slice(0, yamlEnd + 3);

  const autoGenMarker = '\n---\n\n[AUTO-GENERATED API REFERENCE BELOW]\n';
  const output = yamlFrontmatter + '\n\n' + agentsMdContent.trim() + autoGenMarker + '\n' + sections.join('\n') + STATIC_FOOTER;

  const outPath = path.resolve(__dirname, '../public/skill.md');
  fs.writeFileSync(outPath, output, 'utf-8');
  console.log(`Generated ${outPath} (${output.length} bytes)`);

  // Also write the OpenAPI spec JSON for production runtime
  // (swagger-jsdoc scans source files which aren't available in Docker runner)
  const specDir = path.resolve(__dirname, '../src/generated');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.resolve(specDir, 'openapi-spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf-8');
  console.log(`Generated ${specPath}`);
}

generate();
