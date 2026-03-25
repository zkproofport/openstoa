'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import { resizeImage } from '@/lib/utils';

export default function EditTopicPage() {
  const params = useParams();
  const router = useRouter();
  const topicId = params.topicId as string;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [existingImage, setExistingImage] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);

  useEffect(() => {
    async function loadTopic() {
      try {
        const res = await fetch(`/api/topics/${topicId}`);
        if (res.status === 401) {
          router.replace('/');
          return;
        }
        if (res.status === 403 || res.status === 404) {
          setError('Topic not found or you do not have access.');
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error('Failed to load topic');

        const data = await res.json();
        const topic = data.topic;

        // Check ownership
        if (data.currentUserRole !== 'owner') {
          setError('Only the topic owner can edit this topic.');
          setLoading(false);
          return;
        }

        setTitle(topic.title || '');
        setDescription(topic.description || '');
        if (topic.image) {
          setExistingImage(topic.image);
          setImagePreview(topic.image);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load topic');
      } finally {
        setLoading(false);
      }
    }
    loadTopic();
  }, [topicId, router]);

  async function uploadTopicImage(file: File): Promise<string> {
    const resized = await resizeImage(file, 400);
    const filename = `topic-image.webp`;

    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename,
        contentType: 'image/webp',
        size: resized.size,
        purpose: 'topic',
      }),
    });

    if (!res.ok) throw new Error('Failed to get upload URL');
    const { uploadUrl, publicUrl } = await res.json();

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: resized,
    });

    if (!uploadRes.ok) throw new Error('Failed to upload image');
    return publicUrl;
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('Image must be under 10MB');
      return;
    }
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setRemoveImage(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    let imageUrl: string | undefined | null;

    if (imageFile) {
      setImageUploading(true);
      try {
        imageUrl = await uploadTopicImage(imageFile);
      } catch {
        setError('Failed to upload image');
        setSubmitting(false);
        setImageUploading(false);
        return;
      }
      setImageUploading(false);
    } else if (removeImage) {
      imageUrl = null;
    }

    try {
      const body: Record<string, unknown> = {};
      body.title = title.trim();
      body.description = description.trim() || null;
      if (imageUrl !== undefined) {
        body.image = imageUrl;
      }

      const res = await fetch(`/api/topics/${topicId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to update topic');
      }

      router.push(`/topics/${topicId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading...</div>
        </div>
      </CommunityLayout>
    );
  }

  if (error && !title) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 14 }}>{error}</p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 14 }}>
            {'\u2190'} Back to topics
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '40px 1.5rem 80px' }}>
        <div style={{ marginBottom: 20 }}>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
            {'\u2190'} Back to topic
          </Link>
        </div>

        <h1
          style={{
            fontSize: 32,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: '0 0 28px',
          }}
        >
          Edit Topic
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Title */}
          <div>
            <label
              htmlFor="title"
              style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Title <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Topic title"
              maxLength={100}
              autoFocus
              style={{
                width: '100%',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '12px 14px',
                color: 'var(--foreground)',
                fontSize: 15,
                outline: 'none',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="description"
              style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Description{' '}
              <span style={{ fontSize: 15, color: 'var(--muted)' }}>(optional)</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this topic about?"
              rows={3}
              style={{
                width: '100%',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '12px 14px',
                color: 'var(--foreground)',
                fontSize: 14,
                outline: 'none',
                resize: 'vertical',
                lineHeight: 1.6,
                fontFamily: 'inherit',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Topic Image */}
          <div>
            <label
              style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Topic Image{' '}
              <span style={{ fontSize: 15, color: 'var(--muted)' }}>(optional)</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {imagePreview && !removeImage ? (
                <div style={{ position: 'relative' }}>
                  <img
                    src={imagePreview}
                    alt="Preview"
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: '50%',
                      objectFit: 'cover',
                      border: '2px solid rgba(255,255,255,0.1)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setImageFile(null);
                      setImagePreview(null);
                      setRemoveImage(true);
                    }}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: '#ef4444',
                      color: '#fff',
                      border: 'none',
                      fontSize: 14,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </div>
              ) : (
                <label
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: '50%',
                    border: '2px dashed rgba(255,255,255,0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: 28,
                    color: 'rgba(255,255,255,0.2)',
                    transition: 'border-color 0.12s',
                  }}
                >
                  +
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    style={{ display: 'none' }}
                  />
                </label>
              )}
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                Recommended: square image, at least 200x200px.
                <br />
                Max 10MB. Will be resized to 400px.
              </div>
            </div>
          </div>

          {error && (
            <p style={{ color: '#ef4444', fontSize: 14 }}>{error}</p>
          )}

          {/* Submit */}
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              style={{
                flex: 1,
                background: !title.trim() || submitting ? 'rgba(59,130,246,0.3)' : 'var(--accent)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '12px 0',
                fontSize: 15,
                fontWeight: 700,
                cursor: !title.trim() || submitting ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s',
              }}
            >
              {imageUploading ? 'Uploading image...' : submitting ? 'Saving...' : 'Save Changes'}
            </button>
            <Link
              href={`/topics/${topicId}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 24px',
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8,
                textDecoration: 'none',
                transition: 'all 0.12s',
              }}
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </CommunityLayout>
  );
}
