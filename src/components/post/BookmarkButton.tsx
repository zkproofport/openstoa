'use client';

import { useEffect, useState } from 'react';
import { BookmarkIcon } from '@/components/icons';
import { usePostMutations } from '@/hooks/usePostMutations';

interface BookmarkButtonProps {
  postId: string;
  bookmarked?: boolean;
  /** Guests can't bookmark — hide the button entirely. */
  disabled?: boolean;
  /** Skip the initial GET probe (caller already has the bookmark state). */
  initialKnown?: boolean;
  onChange?: (next: boolean) => void;
  size?: 'sm' | 'md';
}

// Interactive bookmark button — works the same way on list rows AND the
// detail page. Owns its optimistic state, calls the shared toggle from
// usePostMutations.
export default function BookmarkButton({
  postId,
  bookmarked,
  disabled,
  initialKnown,
  onChange,
  size = 'md',
}: BookmarkButtonProps) {
  const [state, setState] = useState<boolean>(!!bookmarked);
  const [pending, setPending] = useState(false);
  const { toggleBookmark } = usePostMutations(postId);

  // If the parent passed an explicit value, follow it.
  useEffect(() => {
    if (typeof bookmarked === 'boolean') {
      setState(bookmarked);
    }
  }, [bookmarked]);

  // Lazy-fetch the initial bookmark flag when the parent doesn't know
  // it yet (lists usually don't include `userBookmarked`).
  useEffect(() => {
    if (initialKnown || typeof bookmarked === 'boolean' || disabled) return;
    let cancelled = false;
    fetch(`/api/posts/${postId}/bookmark`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setState(!!data.bookmarked);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [postId, initialKnown, bookmarked, disabled]);

  if (disabled) return null;

  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    const prev = state;
    const optimistic = !prev;
    setState(optimistic);
    onChange?.(optimistic);
    setPending(true);
    try {
      const res = await toggleBookmark(prev);
      setState(res.next);
      onChange?.(res.next);
    } finally {
      setPending(false);
    }
  };

  const iconSize = size === 'sm' ? 14 : 16;
  const padding = size === 'sm' ? '5px 10px' : '6px 10px';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={state ? 'Remove bookmark' : 'Bookmark'}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding,
        borderRadius: 9999,
        fontSize: size === 'sm' ? 12 : 14,
        color: state ? 'var(--accent)' : '#6b7280',
        transition: 'color 0.12s, background 0.12s',
      }}
    >
      <BookmarkIcon size={iconSize} filled={state} />
    </button>
  );
}
