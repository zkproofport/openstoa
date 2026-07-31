'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
  placeholder?: string;
  topicId?: string;
}

interface TagSuggestion {
  name: string;
  slug: string;
  postCount: number;
}

export default function TagInput({ tags, onChange, maxTags = 5, placeholder, topicId }: TagInputProps) {
  const { t } = useTranslation();
  const effectivePlaceholder = placeholder ?? t('tagInput.placeholder');
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`/api/tags?q=${encodeURIComponent(query.trim().toLowerCase())}${topicId ? `&topicId=${topicId}` : ''}`);
      if (res.ok) {
        const data = await res.json();
        setSuggestions((data.tags || []).filter((t: TagSuggestion) => !tags.includes(t.name)));
      }
    } catch {
      // Ignore fetch errors for autocomplete
    }
  }, [tags]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (input.trim().length >= 1) {
      debounceRef.current = setTimeout(() => fetchSuggestions(input), 200);
    } else {
      setSuggestions([]);
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input, fetchSuggestions]);

  const addTag = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (tags.length >= maxTags) return;
    if (tags.some(t => t.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...tags, trimmed]);
    setInput('');
    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedIndex(-1);
    inputRef.current?.focus();
  };

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && suggestions[selectedIndex]) {
        addTag(suggestions[selectedIndex].name);
      } else if (input.trim()) {
        addTag(input);
      }
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags.length - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSelectedIndex(-1);
    } else if (e.key === ',' || e.key === 'Tab') {
      if (input.trim()) {
        e.preventDefault();
        addTag(input);
      }
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 7,
          minHeight: 42,
          alignItems: 'center',
          cursor: 'text',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {tags.map((tag, i) => (
          <span
            key={tag}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'var(--color-brand-primary-muted)',
              color: 'var(--accent)',
              border: '1px solid color-mix(in srgb, var(--color-brand-primary) 20%, transparent)',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 'var(--text-caption)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(i); }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: 0,
                fontSize: 'var(--text-body-sm)',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {tags.length < maxTags && (
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            placeholder={tags.length === 0 ? effectivePlaceholder : ''}
            style={{
              flex: 1,
              minWidth: 80,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--foreground)',
              // var(--text-body) = 16px: below that, iOS Safari zooms on focus.
              fontSize: 'var(--text-body)',
              padding: 0,
            }}
          />
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
        {t('tagInput.helper', { count: tags.length, max: maxTags })}
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--color-bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            marginTop: 4,
            zIndex: 50,
            overflow: 'hidden',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {suggestions.map((s, i) => (
            <div
              key={s.slug}
              onMouseDown={() => addTag(s.name)}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: i === selectedIndex ? 'var(--color-brand-primary-muted)' : 'transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontSize: 'var(--text-caption)', fontFamily: 'var(--font-mono)', color: 'var(--foreground)' }}>{s.name}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{t('tagInput.postCount', { count: s.postCount })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
