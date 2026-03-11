/**
 * Convert @mentions in text to HTML with highlighted spans.
 * Input: "Hey @alice check this out"
 * Output: 'Hey <span class="mention">@alice</span> check this out'
 */
export function renderMentions(text: string): string {
  return text.replace(
    /@([a-zA-Z0-9가-힣_]+)/g,
    '<span style="color:var(--accent);font-weight:600;background:rgba(59,130,246,0.1);padding:0 3px;border-radius:3px;cursor:default;">@$1</span>',
  );
}
