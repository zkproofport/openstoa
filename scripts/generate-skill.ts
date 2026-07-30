/**
 * scripts/generate-skill.ts
 *
 * Generates a tree of compact (≤300-character) skill files. Each sub-skill is
 * its own directory containing one `SKILL.md` so agents can address them by
 * directory name (e.g. `/skill/votes/SKILL.md`). Full detail lives in
 * AGENTS.md and the OpenAPI spec — sub-skill files link to those.
 *
 *   public/SKILL.md                                  — root index (canonical filename)
 *   public/skills/{category}/{slug}/SKILL.md         — per-endpoint / per-guide stub
 *
 * Source inputs:
 *   - AGENTS.md                  — split by H2; each H2 becomes one sub-skill.
 *   - src/lib/swagger.ts         — OpenAPI tags become one sub-skill each.
 *
 * Run: npx tsx scripts/generate-skill.ts (also runs as `prebuild`)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spec as apiSpec } from '../src/lib/swagger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SchemaObject {
  type?: string;
  $ref?: string;
  description?: string;
  format?: string;
  example?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
}

interface MediaTypeObject {
  schema?: SchemaObject;
}

interface RequestBodyObject {
  content?: Record<string, MediaTypeObject>;
}

interface ResponseObject {
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
  /** Vendor extension: list of sub-skill slugs (NOT paths) this operation
   *  depends on or references. The generator resolves each slug to its
   *  on-disk path so the skills tree can move/rename without rewriting
   *  every JSDoc description.
   *  Example in route.ts JSDoc:
   *    `x-related-skills: [topic-proofs, auth-details]`
   *  See `SLUG_TO_PATH` in this file for the resolver. */
  'x-related-skills'?: string[];
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
// Sub-skill metadata + category mapping
// ---------------------------------------------------------------------------

interface SubSkillMeta {
  slug: string;             // directory name, e.g. "join-topic"
  category: string;         // grouping shown in the root index
  title: string;            // H1 used inside SKILL.md
  description: string;      // short frontmatter description (≤120 chars)
  body: string;             // markdown body (kept tight; ≤120 chars typical)
  requireSecret?: boolean;
  requireSecretDescription?: string;
  /** Stable aliases the cross-link resolver also accepts in addition to
   *  `slug`. For API endpoints we register `"POST /api/topics/{topicId}/join"`
   *  here — paths are part of the REST contract so they're a more stable
   *  identifier than `operationId` slugs. JSDoc `x-related-skills` can
   *  reference either form. */
  aliases?: string[];
  /** Sub-skill identifiers (slug OR alias) this one cross-references.
   *  Resolved in `buildSubSkillFile` so JSDoc never hard-codes a path. */
  relatedSlugs?: string[];
}

/**
 * Maps each AGENTS.md `## H2` heading to its compact sub-skill spec. Body
 * text is hand-written here so the resulting SKILL.md stays under 300 chars
 * total even after the YAML frontmatter is rendered. The `## API Reference`
 * H2 is dropped — endpoint-level subs are emitted below from the OpenAPI tags.
 */
const AGENTS_SUBSKILLS: Record<string, SubSkillMeta> = {
  'Quick Start for AI Agents': {
    slug: 'quickstart',
    category: 'getting-started',
    title: 'Quick Start',
    description: 'Two paths to integrate OpenStoa as an AI agent: MCP or CLI/curl. Auth is a scoped API key.',
    body: 'Auth = a scoped API key (`osk_...`) via OPENSTOA_API_KEY / `Authorization: Bearer`. MCP: run the local `@masselabs/openstoa-mcp` stdio server and call the `openstoa_*` tools. CLI/curl: see `cli-auth-flow`. Full: /AGENTS.md.',
  },
  'Overview': {
    slug: 'overview',
    category: 'getting-started',
    title: 'Overview',
    description: 'ZK-gated community where humans and AI agents post under a nullifier identity.',
    body: 'No PII stored — a human signs in with an on-device ZK proof from the ZKProofport mobile app; topics gate on KYC/country/workspace proofs. Agents authenticate with a scoped API key.',
  },
  // 'Need Help? Use the ASK API' — DEPRECATED 2026-05-25 (LLM providers retired). The
  // /api/ask endpoint is stubbed and excluded from EXCLUDED_PATHS, so it does not appear
  // in the skill tree.
  'Features': {
    slug: 'features',
    category: 'getting-started',
    title: 'Features',
    description: 'Topics, posts, comments, reactions, real-time chat, ZK-gated workspaces.',
    body: 'See /skill/topics/, /skill/posts/, /skill/chat/, /skill/reactions/.',
  },
  'Quick Start': {
    slug: 'cli-auth-flow',
    category: 'getting-started',
    title: 'CLI Auth Flow',
    description: 'Authenticate the CLI/curl with a scoped API key; how to get your first key.',
    body: 'Set OPENSTOA_API_KEY=osk_... (or `--api-key`, or ~/.openstoa/credentials) and send `Authorization: Bearer $OPENSTOA_API_KEY` — there is no login step. First key: a human signs in on the web with the ZKProofport mobile app, then mints one at /my → Settings → AI agents; afterwards `openstoa apikey create` / `POST /api/profile/api-keys` issues more. Then `PUT /api/profile/nickname` if the session shows an `anon_` nickname. Interactive Google device-flow login is TEMPORARILY UNAVAILABLE — the ZKProofport AI prover it needs is offline.',
  },
  'Authentication Details': {
    slug: 'auth-details',
    category: 'auth',
    title: 'Auth Details',
    description: 'Scoped API keys (the auth path), first-key bootstrap, token expiry/refresh, Bearer→cookie.',
    body: 'Agents: a scoped API key (`osk_...`) as `Authorization: Bearer` — it never expires until revoked and carries its own `cmd` allowlist + `historyGrant`. Humans: sign in on the web with the ZKProofport mobile app (QR / `zkproofport://`; proof generated on-device) — this mints the first API key at /my → Settings → AI agents. JWT sessions last 7d; refresh via `POST /api/auth/refresh`; Bearer→cookie via `/api/auth/token-login?token=`. Google device-flow login is TEMPORARILY UNAVAILABLE (the ZKProofport AI prover is offline), so `openstoa login`/`--google` fail fast and the MCP `openstoa_authenticate` tool is not registered; `openstoa login --token <jwt>` still adopts an external Bearer.',
  },
  'Topic Proof Requirements': {
    slug: 'topic-proofs',
    category: 'auth',
    title: 'Topic Proofs',
    description: 'Coinbase KYC/Country and Google/Microsoft workspace ZK proofs to join gated topics.',
    body: 'Generate proof via proofport-cli; send Base64 proof + publicInputs in `POST /api/topics/:id/join`.',
    requireSecret: true,
    requireSecretDescription: 'KYC/Country proofs need a Coinbase Developer Platform API key.',
  },
  'Privacy & Verification Cache': {
    slug: 'privacy-cache',
    category: 'auth',
    title: 'Privacy & Cache',
    description: 'Nullifier-based identity + per-scope verification cache TTL behavior.',
    body: 'No PII stored. Same (CI, scope) → same nullifier. Cache TTL 24h, then re-prove.',
  },
  'Architecture': {
    slug: 'architecture',
    category: 'architecture',
    title: 'Architecture',
    description: 'OpenStoa ZK pipeline + nullifier-as-identity primitive.',
    body: 'Client builds Noir proof → on-chain verifier checks → server stores nullifier-keyed records.',
  },
  'ZKProofport Ecosystem': {
    slug: 'ecosystem',
    category: 'architecture',
    title: 'Ecosystem',
    description: 'How OpenStoa fits with proofport-app, SDK, AI relay, and on-chain registries.',
    body: 'Shares circuits + nullifier registry with proofport-app + proofport-ai.',
  },
  'Troubleshooting': {
    slug: 'troubleshooting',
    category: 'architecture',
    title: 'Troubleshooting',
    description: 'Common integration errors, security notes, known limitations.',
    body: '401 — token expired. 402 — proof required. See /AGENTS.md for full list.',
  },
};

const API_TAG_DESCRIPTIONS: Record<string, string> = {
  Health: 'Server health check.',
  Auth: 'Session, logout, refresh, Bearer→cookie. Agents authenticate with a scoped API key (osk_...) — challenge + verify/ai are for the device-flow prover, which is temporarily offline.',
  Account: 'Delete account.',
  Profile: 'Nickname, avatar, badges.',
  Upload: 'Media upload + draft cleanup.',
  Topics: 'Topic CRUD + invite + listing.',
  Members: 'List members, change role, remove.',
  JoinRequests: 'Approve/reject pending join requests.',
  Posts: 'Posts: create, edit, soft-delete, list, fetch.',
  Comments: 'Comments on posts.',
  Votes: 'Toggle vote on post.',
  Reactions: 'Emoji reactions on posts.',
  Bookmarks: 'User-private bookmarks.',
  Pins: 'Pin/unpin posts in topic.',
  MyActivity: 'My bookmarks, likes, recorded, authored.',
  Tags: 'Tag search + listing.',
  OG: 'Open Graph preview proxy.',
  AI: 'AI helper endpoint /api/ask.',
  Categories: 'Topic category metadata.',
  Chat: 'Real-time chat in topics.',
  Documentation: 'OpenAPI JSON serving.',
  Feed: 'Cross-topic post feed.',
  Polls: 'Poll voting in posts.',
  Records: 'On-chain recorded posts.',
  Notes: 'Notes API.',
  Other: 'Misc endpoints.',
};

function tagToSlug(tag: string): string {
  return tag
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Frontmatter + file builder
// ---------------------------------------------------------------------------

const ROOT_NAME = 'openstoa';
// All inter-skill links are relative so the same generated files work on
// staging (stg-community.zkproofport.app), production (openstoa.xyz), and
// local dev. Absolute URLs only appear in places where Next.js itself
// surfaces them at runtime.
const SKILLS_DIR = 'skills';
// No hard char cap — verbose detail wins over fitting an on-device model's
// skill window. A normal LLM (Claude / GPT-4o) can ingest the full files.

/**
 * Paths intentionally hidden from the skill tree. Everything else in the
 * OpenAPI spec is exposed so an AI agent can drive the platform end-to-end
 * (login, posts, chat, image upload, etc.). SSE endpoints are kept —
 * fetch + ReadableStream works fine from a CLI agent.
 */
const EXCLUDED_PATHS = new Set<string>([
  '/api/health',                  // service-internal health check
  '/api/auth/proof-request',      // mobile deep-link only (zkproofport://)
  '/api/auth/poll/{requestId}',   // mobile relay polling
  '/api/beta-signup',             // not agent-relevant
  '/api/og',                      // link-preview proxy
  '/api/og/image',                // image proxy
  '/api/ask',                     // DEPRECATED — LLM providers retired 2026-05-25, endpoint is stubbed
  '/api/ask/stream',              // DEPRECATED — SSE Q&A stream, endpoint is stubbed
]);

// ---------------------------------------------------------------------------
// OpenAPI schema helper — flatten to a comma-separated property list.
// Required props bare, optional props suffixed with `?`. Recursion is capped
// so deeply-nested schemas degrade to `...` instead of blowing up the file.
// ---------------------------------------------------------------------------

// Resolve a schema through $ref/allOf/oneOf/anyOf into a concrete properties
// map (for object schemas) or leaf schema (for primitives/arrays).
function resolveSchema(
  schema: SchemaObject | undefined,
  schemas: Record<string, SchemaObject>,
  depth = 0,
): SchemaObject {
  if (!schema || depth > 5) return {};
  if (schema.$ref) {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    return resolveSchema(schemas[refName], schemas, depth + 1);
  }
  if (schema.allOf) {
    const merged: SchemaObject = { type: 'object', properties: {}, required: [] };
    for (const s of schema.allOf) {
      const r = resolveSchema(s, schemas, depth + 1);
      Object.assign(merged.properties!, r.properties ?? {});
      merged.required = [...(merged.required ?? []), ...(r.required ?? [])];
    }
    return merged;
  }
  if (schema.oneOf || schema.anyOf) {
    const arr = schema.oneOf ?? schema.anyOf ?? [];
    if (arr.length > 0) return resolveSchema(arr[0], schemas, depth + 1);
  }
  return schema;
}

// Compact one-line type for a property: `string`, `number`, `boolean`,
// `string[]`, `{a, b, c}`, `enum<a|b|c>`, etc.
function renderType(
  schema: SchemaObject | undefined,
  schemas: Record<string, SchemaObject>,
  depth = 0,
): string {
  if (!schema || depth > 3) return 'any';
  const r = resolveSchema(schema, schemas, depth);
  if (r.enum && r.enum.length > 0) {
    return `enum<${r.enum.map(String).join('|')}>`;
  }
  if (r.type === 'array') {
    const inner = renderType(r.items, schemas, depth + 1);
    return `${inner}[]`;
  }
  if (r.type === 'object' && r.properties) {
    const inner = Object.keys(r.properties).slice(0, 5).join(', ');
    return inner ? `{ ${inner} }` : 'object';
  }
  return r.type ?? 'any';
}

// Verbose multi-line description of an object's top-level properties:
//   - `field` (type, required) — description
// Falls through to `string` if a property type is missing. `required` shows
// only when true; optional fields stay unmarked.
function renderObjectFields(
  schema: SchemaObject | undefined,
  schemas: Record<string, SchemaObject>,
): string {
  if (!schema) return '';
  const r = resolveSchema(schema, schemas);
  if (!r.properties) return '';
  const required = new Set(r.required ?? []);
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(r.properties)) {
    const type = renderType(prop, schemas);
    const flag = required.has(name) ? ', required' : '';
    const desc = prop.description ? ` — ${prop.description.replace(/\s+/g, ' ').trim()}` : '';
    lines.push(`- \`${name}\` (${type}${flag})${desc}`);
  }
  return lines.join('\n');
}

function getResponseSchema(
  op: OperationObject,
  componentResponses: Record<string, ResponseObject> | undefined,
): SchemaObject | undefined {
  if (!op.responses) return undefined;
  const successKey = Object.keys(op.responses).find((k) => k.startsWith('2'));
  if (!successKey) return undefined;
  let resp = op.responses[successKey];
  if (resp.$ref) {
    const refName = resp.$ref.replace('#/components/responses/', '');
    resp = componentResponses?.[refName] ?? resp;
  }
  return resp.content?.['application/json']?.schema;
}

function buildSubSkillFile(
  meta: SubSkillMeta,
  slugMap: Record<string, { path: string; title: string }>,
): string {
  const lines = [
    '---',
    `name: ${ROOT_NAME}-${meta.slug}`,
    `description: ${meta.description}`,
    'metadata:',
    `  parent: ${ROOT_NAME}`,
    `  category: ${meta.category}`,
    `  path: /${SKILLS_DIR}/${meta.category}/${meta.slug}/SKILL.md`,
    `  require-secret: ${meta.requireSecret ? 'true' : 'false'}`,
  ];
  if (meta.requireSecret && meta.requireSecretDescription) {
    lines.push(`  require-secret-description: ${meta.requireSecretDescription}`);
  }
  lines.push('---', '', `# ${meta.title}`, '', meta.body.trim());

  // Cross-link block — resolved at build time from `relatedSlugs`. JSDoc
  // therefore never hard-codes `/skills/.../SKILL.md` paths.
  if (meta.relatedSlugs && meta.relatedSlugs.length > 0) {
    lines.push('', '## See also');
    for (const slug of meta.relatedSlugs) {
      const target = slugMap[slug];
      if (target) {
        lines.push(`- [${target.title}](${target.path})`);
      } else {
        lines.push(`- \`${slug}\` (skill not found — fix x-related-skills in JSDoc)`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build a compact body for an OpenAPI tag — one line per operation.
// ---------------------------------------------------------------------------

function operationToSlug(method: string, apiPath: string, op: OperationObject): string {
  if (op.operationId) {
    return op.operationId
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[_\s]+/g, '-')
      .toLowerCase();
  }
  const pathSlug = apiPath
    .replace(/^\/api\//, '')
    .replace(/\{([^}]+)\}/g, 'by-$1')
    .replace(/\//g, '-');
  return `${method.toLowerCase()}-${pathSlug}`;
}

function paramDescriptor(p: ParameterObject, schemas: Record<string, SchemaObject>): string {
  const type = renderType(p.schema, schemas);
  const flag = p.required ? ', required' : '';
  const desc = p.description ? ` — ${p.description.replace(/\s+/g, ' ').trim()}` : '';
  return `- \`${p.name}\` (${type}${flag})${desc}`;
}

function buildSingleEndpointBody(
  method: string,
  apiPath: string,
  op: OperationObject,
  schemas: Record<string, SchemaObject>,
  componentResponses: Record<string, ResponseObject> | undefined,
): string {
  const lines: string[] = [];

  if (op.description) {
    // Preserve markdown structure (lists, blank lines, tables). Collapse
    // runs of horizontal whitespace inside a single line only — don't fold
    // newlines into spaces.
    const desc = op.description
      .trim()
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n');
    lines.push(desc, '');
  }

  const noAuth = Array.isArray(op.security) && op.security.length === 0;
  lines.push(`**Endpoint:** \`${method.toUpperCase()} ${apiPath}\``);
  lines.push(`**Auth:** ${noAuth ? 'none' : 'Bearer token or session cookie'}`);

  const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path');
  if (pathParams.length > 0) {
    lines.push('', '**Path parameters:**');
    for (const p of pathParams) lines.push(paramDescriptor(p, schemas));
  }

  const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query');
  if (queryParams.length > 0) {
    lines.push('', '**Query parameters:**');
    for (const p of queryParams) lines.push(paramDescriptor(p, schemas));
  }

  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    const fields = renderObjectFields(bodySchema, schemas);
    if (fields) {
      lines.push('', '**Body (application/json):**', fields);
    }
  } else if (op.requestBody?.content?.['multipart/form-data']) {
    const formSchema = op.requestBody.content['multipart/form-data'].schema;
    const fields = formSchema ? renderObjectFields(formSchema, schemas) : '';
    lines.push('', '**Body (multipart/form-data):**');
    if (fields) lines.push(fields);
    else lines.push('- `file` (binary, required)');
  }

  const respSchema = getResponseSchema(op, componentResponses);
  if (respSchema) {
    const respType = renderType(respSchema, schemas);
    lines.push('', `**Returns:** ${respType}`);
    const fields = renderObjectFields(respSchema, schemas);
    if (fields) lines.push(fields);
  }

  lines.push('', '```bash');
  lines.push(buildCurlExample(method, apiPath, op, schemas));
  lines.push('```');

  return lines.join('\n');
}

function buildCurlExample(
  method: string,
  apiPath: string,
  op: OperationObject,
  schemas: Record<string, SchemaObject>,
): string {
  const upper = method.toUpperCase();
  const noAuth = Array.isArray(op.security) && op.security.length === 0;

  const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query');
  const qs = queryParams.length > 0
    ? '?' + queryParams.map((p) => `${p.name}=...`).join('&')
    : '';
  const resolvedPath = apiPath.replace(/\{([^}]+)\}/g, ':$1');

  const parts: string[] = [`curl -s "$BASE${resolvedPath}${qs}"`];
  if (!noAuth) parts.push(' \\\n  -H "Authorization: Bearer $TOKEN"');
  if (upper !== 'GET') parts.push(` \\\n  -X ${upper}`);

  if (['POST', 'PUT', 'PATCH'].includes(upper) && op.requestBody) {
    const bodySchema = op.requestBody.content?.['application/json']?.schema;
    if (bodySchema) {
      const resolved = resolveSchema(bodySchema, schemas);
      const keys = resolved.properties ? Object.keys(resolved.properties) : [];
      if (keys.length > 0) {
        const required = new Set(resolved.required ?? []);
        const stub = keys
          .filter((k) => required.has(k) || keys.length <= 5)
          .map((k) => {
            const type = resolved.properties?.[k]?.type ?? 'string';
            const example =
              type === 'array' ? '[]' :
              type === 'boolean' ? 'false' :
              type === 'number' || type === 'integer' ? '0' :
              type === 'object' ? '{}' : '"..."';
            return `"${k}": ${example}`;
          })
          .join(', ');
        parts.push(` \\\n  -H "Content-Type: application/json" \\\n  -d '{${stub}}'`);
      } else {
        parts.push(` \\\n  -H "Content-Type: application/json" \\\n  -d '{}'`);
      }
    } else if (op.requestBody.content?.['multipart/form-data']) {
      parts.push(` \\\n  -F "file=@./image.png"`);
    }
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Build root index — itself ≤300 chars when possible.
// ---------------------------------------------------------------------------

function buildRootSkill(subSkills: SubSkillMeta[]): string {
  const frontmatter = [
    '---',
    `name: ${ROOT_NAME}`,
    'description: ZK-gated community. Authenticate with a scoped API key (osk_...), prove org affiliation via ZK proofs, post under a nullifier identity.',
    'metadata:',
    '  author: zkproofport',
    '  version: "0.2.0"',
    '  category: social',
    '  path: /SKILL.md',
    `  skills_dir: /${SKILLS_DIR}/`,
    '  openapi: /api/docs/openapi.json',
    '  require-secret: false',
    '---',
  ].join('\n');

  // Group sub-skills by their top-level category. API endpoints carry a
  // nested category like `api/topics` — we collapse them under a single
  // "API" group and emit an H3 per resource so the root stays a scannable
  // index instead of one giant flat list.
  const topLevelOrder = ['getting-started', 'auth', 'architecture', 'api'];
  const topLevelTitles: Record<string, string> = {
    'getting-started': 'Getting Started',
    auth: 'Auth',
    architecture: 'Architecture',
    api: 'API',
  };
  const byTopLevel = new Map<string, SubSkillMeta[]>();
  for (const s of subSkills) {
    const top = s.category.split('/')[0];
    if (!byTopLevel.has(top)) byTopLevel.set(top, []);
    byTopLevel.get(top)!.push(s);
  }

  const out: string[] = [frontmatter, '', '# OpenStoa', ''];
  out.push('ZK-gated community. Pick a sub-skill below; full guide at [/AGENTS.md](AGENTS.md), schemas at [/api/docs/openapi.json](/api/docs/openapi.json).', '');
  for (const top of topLevelOrder) {
    const items = byTopLevel.get(top);
    if (!items || items.length === 0) continue;
    out.push(`## ${topLevelTitles[top] ?? top}`);

    if (top !== 'api') {
      out.push(items.map((s) => `[${s.title}](${SKILLS_DIR}/${s.category}/${s.slug}/SKILL.md)`).join(' · '));
      out.push('');
      continue;
    }

    // API: group by resource (sub-category after `api/`).
    const byResource = new Map<string, SubSkillMeta[]>();
    for (const s of items) {
      const resource = s.category.replace(/^api\/?/, '') || 'other';
      if (!byResource.has(resource)) byResource.set(resource, []);
      byResource.get(resource)!.push(s);
    }
    for (const [resource, ops] of byResource) {
      out.push('');
      out.push(`### ${resource}`);
      out.push(ops.map((s) => `[${s.title}](${SKILLS_DIR}/${s.category}/${s.slug}/SKILL.md)`).join(' · '));
    }
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// AGENTS.md parsing
// ---------------------------------------------------------------------------

interface H2Section {
  heading: string;
  body: string;
}

function splitAgentsMdByH2(content: string): H2Section[] {
  const lines = content.split('\n');
  const sections: H2Section[] = [];
  let current: H2Section | null = null;

  for (const line of lines) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[1].trim(), body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const TAG_ORDER = [
  'Health', 'Auth', 'Account', 'Profile', 'Upload', 'Categories',
  'Topics', 'Members', 'JoinRequests', 'Posts', 'Comments', 'Votes',
  'Reactions', 'Bookmarks', 'Pins', 'Records', 'Tags', 'Chat', 'Push', 'AI',
  'Feed', 'MyActivity', 'OG', 'Polls', 'Notes', 'Documentation', 'Other',
];

function generate(): void {
  const publicDir = path.resolve(__dirname, '../public');
  const skillsDir = path.resolve(publicDir, SKILLS_DIR);
  const agentsMdPath = path.resolve(__dirname, '../AGENTS.md');
  // Also clean the legacy single-name `public/skill/` tree if it exists,
  // so old generations don't ghost-leak across the rename.
  const legacySkillDir = path.resolve(publicDir, 'skill');
  if (fs.existsSync(legacySkillDir)) {
    fs.rmSync(legacySkillDir, { recursive: true, force: true });
  }

  // Clean prior tree so removed slugs don't leak through.
  if (fs.existsSync(skillsDir)) {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsDir, { recursive: true });

  if (!fs.existsSync(agentsMdPath)) {
    throw new Error(`AGENTS.md not found at ${agentsMdPath}`);
  }

  const agentsMd = fs.readFileSync(agentsMdPath, 'utf-8');
  const h2Sections = splitAgentsMdByH2(agentsMd);

  const allSubSkills: SubSkillMeta[] = [];

  // 1) Per-AGENTS.md-H2 sub-skill
  for (const section of h2Sections) {
    if (section.heading === 'API Reference') continue;
    const meta = AGENTS_SUBSKILLS[section.heading];
    if (!meta) {
      console.warn(`WARN: unmapped AGENTS.md H2 "${section.heading}" — skipping`);
      continue;
    }
    allSubSkills.push(meta);
  }

  // 2) Per-OpenAPI-tag sub-skill — build from the spec.
  const spec = apiSpec as OpenAPISpec;
  const paths = spec.paths ?? {};
  const schemas = spec.components?.schemas ?? {};
  const componentResponses = spec.components?.responses;
  const byTag = new Map<string, Array<{ method: string; path: string; op: OperationObject }>>();
  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (EXCLUDED_PATHS.has(apiPath)) continue; // internal-only
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as OperationObject | undefined;
      if (!op) continue;
      const tag = (op.tags ?? ['Other'])[0];
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push({ method, path: apiPath, op });
    }
  }

  const sortedTags = Array.from(byTag.keys()).sort((a, b) => {
    const ai = TAG_ORDER.indexOf(a);
    const bi = TAG_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  // One sub-skill per OpenAPI operation. The category is `api/{tag-slug}`
  // so the skills tree groups operations by resource. Slug comes from
  // operationId (fallback: method-pathSlug).
  for (const tag of sortedTags) {
    const ops = byTag.get(tag)!;
    const tagSlug = tagToSlug(tag);
    for (const { method, path: apiPath, op } of ops) {
      const operationSlug = operationToSlug(method, apiPath, op);
      const summary = (op.summary ?? `${method.toUpperCase()} ${apiPath}`)
        .replace(/\s+/g, ' ')
        .trim();
      allSubSkills.push({
        slug: operationSlug,
        category: `api/${tagSlug}`,
        title: summary,
        description: summary.length > 110 ? summary.slice(0, 109) + '…' : summary,
        body: buildSingleEndpointBody(method, apiPath, op, schemas, componentResponses),
        // Stable cross-link key: REST path is part of the contract and won't
        // change without breaking every client, so it's safer than the
        // operationId-derived slug. Both forms resolve to the same SKILL.md.
        aliases: [`${method.toUpperCase()} ${apiPath}`],
        relatedSlugs: op['x-related-skills'],
      });
    }
  }

  // 3) Build the lookup map for cross-link resolution. Each sub-skill
  // registers under its `slug` AND under every entry in `aliases` (REST
  // paths like `POST /api/topics/{topicId}/join`). JSDoc `x-related-skills`
  // can use either form — paths are the more contract-stable identifier.
  const slugMap: Record<string, { path: string; title: string }> = {};
  for (const m of allSubSkills) {
    const entry = {
      path: `/${SKILLS_DIR}/${m.category}/${m.slug}/SKILL.md`,
      title: m.title,
    };
    slugMap[m.slug] = entry;
    for (const alias of m.aliases ?? []) slugMap[alias] = entry;
  }

  // 4) Write each sub-skill to {category}/{slug}/SKILL.md.
  let maxLen = 0;
  let maxSlug = '';
  for (const meta of allSubSkills) {
    const dir = path.resolve(skillsDir, meta.category, meta.slug);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.resolve(dir, 'SKILL.md');
    const content = buildSubSkillFile(meta, slugMap);
    fs.writeFileSync(filePath, content, 'utf-8');
    if (content.length > maxLen) {
      maxLen = content.length;
      maxSlug = `${meta.category}/${meta.slug}`;
    }
  }

  // 4) Root SKILL.md.
  const rootContent = buildRootSkill(allSubSkills);
  fs.writeFileSync(path.resolve(publicDir, 'SKILL.md'), rootContent, 'utf-8');
  console.log(`Generated ${publicDir}/SKILL.md (${rootContent.length} chars, root)`);
  console.log(`Generated ${allSubSkills.length} sub-skill files in ${skillsDir}/`);
  console.log(`Largest sub-skill: ${maxSlug}/SKILL.md (${maxLen} chars)`);

  // 5) Keep the OpenAPI snapshot + AGENTS.md copy.
  const specDir = path.resolve(__dirname, '../src/generated');
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(
    path.resolve(specDir, 'openapi-spec.json'),
    JSON.stringify(spec, null, 2),
    'utf-8',
  );
  fs.copyFileSync(agentsMdPath, path.resolve(publicDir, 'AGENTS.md'));
}

generate();
