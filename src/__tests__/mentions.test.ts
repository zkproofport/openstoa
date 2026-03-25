import { describe, it, expect } from 'vitest';
import { renderMentions } from '@/lib/mentions';

const SPAN_PREFIX = '<span style="color:var(--accent);font-weight:600;background:rgba(59,130,246,0.1);padding:0 3px;border-radius:3px;cursor:default;">';
const SPAN_SUFFIX = '</span>';

function mentionSpan(name: string): string {
  return `${SPAN_PREFIX}@${name}${SPAN_SUFFIX}`;
}

describe('renderMentions', () => {
  it('wraps a basic mention in a span', () => {
    const result = renderMentions('Hey @alice check this');
    expect(result).toBe(`Hey ${mentionSpan('alice')} check this`);
  });

  it('handles multiple mentions in one string', () => {
    const result = renderMentions('@alice and @bob are here');
    expect(result).toBe(`${mentionSpan('alice')} and ${mentionSpan('bob')} are here`);
  });

  it('handles Korean username', () => {
    const result = renderMentions('안녕 @홍길동');
    expect(result).toBe(`안녕 ${mentionSpan('홍길동')}`);
  });

  it('handles underscore in username', () => {
    const result = renderMentions('hello @user_name');
    expect(result).toBe(`hello ${mentionSpan('user_name')}`);
  });

  it('returns unchanged string when no mentions', () => {
    const input = 'no mentions here at all';
    expect(renderMentions(input)).toBe(input);
  });

  it('matches @domain part of email-like text', () => {
    const result = renderMentions('user@domain.com');
    expect(result).toBe(`user${mentionSpan('domain')}.com`);
  });

  it('handles mention at start of string', () => {
    const result = renderMentions('@alice hello');
    expect(result).toBe(`${mentionSpan('alice')} hello`);
  });

  it('handles mention at end of string', () => {
    const result = renderMentions('hello @alice');
    expect(result).toBe(`hello ${mentionSpan('alice')}`);
  });

  it('handles adjacent mentions', () => {
    const result = renderMentions('@alice @bob');
    expect(result).toBe(`${mentionSpan('alice')} ${mentionSpan('bob')}`);
  });
});
