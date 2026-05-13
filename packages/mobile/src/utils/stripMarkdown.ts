/**
 * Lightweight inline markdown/HTML stripper for previews.
 * Removes common markup so a content snippet is readable in `numberOfLines`
 * truncation. Not a full parser — keeps visible text only.
 */
export function stripMarkdown(input: string): string {
  if (!input) return '';
  let s = input;
  // Code fences and inline code
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  // Images: ![alt](url) -> alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Links: [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Headings, blockquotes, list bullets, hr
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, '');
  // Bold/italic/strikethrough markers
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  // HTML tags
  s = s.replace(/<[^>]+>/g, '');
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
