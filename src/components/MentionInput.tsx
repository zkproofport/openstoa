'use client';

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';

interface MentionSuggestion {
  userId: string;
  nickname: string;
}

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  topicId: string;
  placeholder?: string;
  style?: React.CSSProperties;
}

export default function MentionInput({
  value,
  onChange,
  topicId,
  placeholder,
  style,
}: MentionInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [suggestions, setSuggestions] = useState<MentionSuggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mentionStart, setMentionStart] = useState<number | null>(null);
  const [dropdownTop, setDropdownTop] = useState(0);
  const [dropdownLeft, setDropdownLeft] = useState(0);
  const fetchRef = useRef<AbortController | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchMembers = useCallback(
    async (q: string) => {
      if (fetchRef.current) fetchRef.current.abort();
      const ctrl = new AbortController();
      fetchRef.current = ctrl;
      try {
        const res = await fetch(
          `/api/topics/${topicId}/members?q=${encodeURIComponent(q)}`,
          { signal: ctrl.signal },
        );
        if (!res.ok) return;
        const data = await res.json();
        setSuggestions(data.members ?? []);
        setActiveIndex(0);
      } catch {
        // aborted or error — ignore
      }
    },
    [topicId],
  );

  const closeMention = useCallback(() => {
    setShowDropdown(false);
    setSuggestions([]);
    setMentionStart(null);
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      const cursor = e.target.selectionStart ?? newValue.length;

      // Find the nearest @ before the cursor on the same line
      const textBefore = newValue.slice(0, cursor);
      const atIndex = textBefore.lastIndexOf('@');

      if (atIndex === -1) {
        closeMention();
        return;
      }

      // Ensure there's no whitespace between @ and cursor
      const fragment = textBefore.slice(atIndex + 1);
      if (/\s/.test(fragment)) {
        closeMention();
        return;
      }

      setMentionStart(atIndex);
      setShowDropdown(true);
      fetchMembers(fragment);

      // Position dropdown below textarea (simple: always bottom-left of textarea)
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const ta = textareaRef.current;
        if (ta) {
          setDropdownTop(ta.offsetTop + ta.offsetHeight + 4);
          setDropdownLeft(ta.offsetLeft);
        } else {
          setDropdownTop(rect.height + 4);
          setDropdownLeft(0);
        }
      }
    },
    [onChange, fetchMembers, closeMention],
  );

  const applySuggestion = useCallback(
    (nickname: string) => {
      if (mentionStart === null) return;
      const before = value.slice(0, mentionStart);
      const cursor = textareaRef.current?.selectionStart ?? value.length;
      const after = value.slice(cursor);
      const inserted = `${before}@${nickname} ${after}`;
      onChange(inserted);
      closeMention();

      // Restore focus and move cursor after the inserted mention
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const pos = before.length + nickname.length + 2; // '@' + nickname + ' '
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(pos, pos);
        }
      });
    },
    [value, mentionStart, onChange, closeMention],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!showDropdown || suggestions.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestions[activeIndex].nickname);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
      }
    },
    [showDropdown, suggestions, activeIndex, applySuggestion, closeMention],
  );

  // Close dropdown on outside click
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeMention();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [closeMention]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        style={{
          width: '100%',
          background: '#1a1a1a',
          border: '1px solid #333',
          borderRadius: '6px',
          color: '#fff',
          padding: '10px 12px',
          fontSize: '14px',
          lineHeight: '1.5',
          resize: 'vertical',
          outline: 'none',
          fontFamily: 'inherit',
          minHeight: '80px',
          ...style,
        }}
      />
      {showDropdown && suggestions.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: dropdownTop,
            left: dropdownLeft,
            zIndex: 1000,
            background: '#111',
            border: '1px solid #333',
            borderRadius: '6px',
            margin: 0,
            padding: '4px 0',
            listStyle: 'none',
            minWidth: '180px',
            maxWidth: '280px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          {suggestions.map((s, i) => (
            <li
              key={s.userId}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(s.nickname);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              style={{
                padding: '7px 14px',
                cursor: 'pointer',
                color: '#fff',
                fontSize: '13px',
                background: i === activeIndex ? 'rgba(59,130,246,0.2)' : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              <span style={{ color: 'var(--accent, #3b82f6)', fontWeight: 600 }}>@</span>
              {s.nickname}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
