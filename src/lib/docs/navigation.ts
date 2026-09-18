/** Stable document URLs; old section fragments continue to open the right subject. */
export const DOCS_TOPICS = [
  { id: 'intro', label: 'navIntro', group: 'navBasics' },
  { id: 'login', label: 'navLogin', group: 'navBasics' },
  { id: 'topics', label: 'navTopics', group: 'navUsing' },
  { id: 'posts', label: 'navPosts', group: 'navUsing' },
  { id: 'chat', label: 'navChat', group: 'navUsing' },
  { id: 'proof-login', label: 'navProofLogin', group: 'navProofs' },
  { id: 'proof-workspace', label: 'navProofWorkspace', group: 'navProofs' },
  { id: 'proof-kyc', label: 'navProofKyc', group: 'navProofs' },
  { id: 'proof-country', label: 'navProofCountry', group: 'navProofs' },
  { id: 'commands', label: 'navCommands', group: 'navReference' },
  { id: 'rest', label: 'navRest', group: 'navReference' },
] as const;
export type DocsTopic = typeof DOCS_TOPICS[number]['id'];
const LEGACY: Record<string, DocsTopic> = {
  'path-b': 'login', 'advanced-rest': 'rest', step1: 'rest', step2: 'rest', step3: 'rest',
  step4: 'topics', step5: 'posts', 'cli-guide': 'commands', 'cli-reference': 'commands',
  'cli-global-options': 'commands', 'cli-unavailable': 'commands', 'cli-read': 'topics',
  'cli-publish': 'posts', 'cli-privacy': 'chat', 'cli-chat': 'chat', 'cli-dm': 'chat', 'cli-local-state': 'chat',
};
export function resolveDocsTopic(hash: string): DocsTopic {
  const id = hash.replace(/^#/, '');
  return DOCS_TOPICS.find(topic => topic.id === id)?.id ?? LEGACY[id] ?? 'intro';
}
