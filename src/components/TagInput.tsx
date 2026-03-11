'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

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

export default function TagInput({ tags, onChange, maxTags = 5, placeholder = 'Add tags...', topicId }: TagInputProps) {
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
          padding: '8px 12px',
          background: '#111',
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
              background: 'rgba(59,130,246,0.12)',
              color: 'var(--accent)',
              border: '1px solid rgba(59,130,246,0.2)',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 13,
              fontFamily: 'monospace',
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
                fontSize: 14,
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
            placeholder={tags.length === 0 ? placeholder : ''}
            style={{
              flex: 1,
              minWidth: 80,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--foreground)',
              fontSize: 14,
              padding: 0,
            }}
          />
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: 'monospace' }}>
        {tags.length}/{maxTags} tags · press Enter or comma to add
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: '#0d0d0d',
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
                padding: '8px 12px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: i === selectedIndex ? 'rgba(59,130,246,0.1)' : 'transparent',
                transition: 'background 0.1s',
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--foreground)' }}>{s.name}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{s.postCount} posts</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
