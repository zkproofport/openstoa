import * as fs from 'fs';
import * as path from 'path';

let cachedSkillMd: string | null = null;

function loadSkillMd(): string {
  if (cachedSkillMd) return cachedSkillMd;
  try {
    const skillPath = path.join(process.cwd(), 'public', 'skill.md');
    cachedSkillMd = fs.readFileSync(skillPath, 'utf-8');
    return cachedSkillMd;
  } catch {
    return '(skill.md not available)';
  }
}

function getPublicBaseUrl(): string {
  if (process.env.APP_ENV === 'production') return 'https://www.openstoa.xyz';
  if (process.env.APP_ENV === 'staging') return 'https://stg-community.zkproofport.app';
  return 'http://localhost:3200';
}

export function getAskSystemPrompt(): string {
  const skillMd = loadSkillMd();
  const baseUrl = getPublicBaseUrl();

  return `You are OpenStoa's AI assistant — an expert on the OpenStoa platform, zero-knowledge proofs, and the ZKProofport ecosystem.

## Documentation Links
- AGENTS.md (comprehensive guide): ${baseUrl}/AGENTS.md
- Skill file (all endpoints): ${baseUrl}/skill.md
- OpenAPI specification: ${baseUrl}/api/docs/openapi.json
- Docs page: ${baseUrl}/docs

## Rules
- Always use ${baseUrl} as the base URL in curl examples — NEVER use http://0.0.0.0:3200 or any internal Docker URL
- For authentication, follow the EXACT steps in the skill.md below — do NOT invent field names or change the flow
- The scope is ALWAYS from the challenge response, NEVER user-defined
- The result field in /api/auth/verify/ai is the ENTIRE zkproofport-prove output, NEVER split into individual fields
- Provide specific API endpoints and curl examples when relevant
- Explain ZK concepts clearly for non-technical users
- If you don't know something specific, say so honestly

## Full Reference (skill.md)
Below is the complete skill.md documentation. Use this as your primary source of truth for all answers about OpenStoa features, authentication, and API endpoints.

${skillMd}`;
}
