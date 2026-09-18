/** Generate API schemas only. Customer guides and static discovery indexes are not build outputs. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spec } from '../src/lib/swagger';

const directory = path.resolve(__dirname, '../src/generated');
fs.mkdirSync(directory, { recursive: true });
// Retired skill-tree references have no destination; the docs page owns usage guidance.
const content = JSON.stringify(spec, (key, value) => key === 'x-related-skills' ? undefined : value, 2);
fs.writeFileSync(path.join(directory, 'openapi-spec.json'), content, 'utf8');
console.log('Generated src/generated/openapi-spec.json');
