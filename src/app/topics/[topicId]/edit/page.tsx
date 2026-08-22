'use client';

import { apiFetch, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import { resizeImage } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export default function EditTopicPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
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
        const res = await apiFetch(`/api/topics/${topicId}`);
        if (res.status === 401) {
          router.replace('/');
          return;
        }
        if (res.status === 403 || res.status === 404) {
          setError(t('editTopicPage.notFoundOrNoAccess'));
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error(t('editTopicPage.loadFailed'));

        const data = await res.json();
        const topic = data.topic;

        // Check ownership
        if (data.currentUserRole !== 'owner') {
          setError(t('editTopicPage.ownerOnly'));
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
        setError(err instanceof Error ? err.message : t('editTopicPage.loadFailed'));
      } finally {
        setLoading(false);
      }
    }
    loadTopic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, router]);

  async function uploadTopicImage(file: File): Promise<string> {
    const resized = await resizeImage(file, 400);
    const form = new FormData();
    form.append('file', new File([resized], 'topic-image.webp', { type: 'image/webp' }));
    form.append('purpose', 'topic');
    // The topic exists here (unlike the creation form), so its picture can be
    // filed under it and swept with it.
    form.append('topicId', topicId);

    // Upload deadline, not the ordinary one — the clock covers the body.
    const res = await apiFetch('/api/upload', {
      method: 'POST',
      body: form,
      timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(t('editTopicPage.uploadImageFailed'));
    const { publicUrl } = (await res.json()) as { publicUrl: string };
    return publicUrl;
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      setError(t('editTopicPage.imageTooLarge'));
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
        setError(t('editTopicPage.uploadImageFailed'));
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

      const res = await apiFetch(`/api/topics/${topicId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('editTopicPage.updateFailed'));
      }

      router.push(`/topics/${topicId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('editTopicPage.unknownError'));
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
          <div style={{ color: 'var(--muted)', fontSize: 'var(--text-body-sm)' }}>{t('common.loading')}</div>
        </div>
      </CommunityLayout>
    );
  }

  if (error && !title) {
    return (
      <CommunityLayout isGuest={false} sessionChecked={true}>
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <p style={{ color: 'var(--color-status-danger)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-body-sm)' }}>{error}</p>
          <Link href="/topics" style={{ color: 'var(--accent)', fontSize: 'var(--text-body-sm)' }}>
            {'\u2190'} {t('editTopicPage.backToTopics')}
          </Link>
        </div>
      </CommunityLayout>
    );
  }

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      {/* 1.5rem = space-5; 40px/80px vertical rhythm has no exact scale match, kept literal. */}
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '40px var(--space-5) 80px' }}>
        <div style={{ marginBottom: 20 }}>
          <Link href={`/topics/${topicId}`} style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 'var(--text-caption)' }}>
            {'\u2190'} {t('editTopicPage.backToTopic')}
          </Link>
        </div>

        <h1
          style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: '0 0 28px',
          }}
        >
          {t('editTopicPage.title')}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Title */}
          <div>
            <label
              htmlFor="title"
              style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
            >
              {t('editTopicPage.titleLabel')} <span style={{ color: 'var(--color-status-danger)' }}>*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('editTopicPage.titlePlaceholder')}
              maxLength={100}
              autoFocus
              style={{
                width: '100%',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-3) 14px',
                color: 'var(--foreground)',
                // var(--text-body) = 16px: below that, iOS Safari zooms the page on focus.
                fontSize: 'var(--text-body)',
                outline: 'none',
                minHeight: 'var(--touch-target-min)',
                boxSizing: 'border-box',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-brand-primary)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="description"
              style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
            >
              {t('editTopicPage.descriptionLabel')}{' '}
              <span style={{ fontSize: 'var(--text-body)', color: 'var(--muted)' }}>{t('editTopicPage.optional')}</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('editTopicPage.descriptionPlaceholder')}
              rows={3}
              style={{
                width: '100%',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-3) 14px',
                color: 'var(--foreground)',
                // var(--text-body) = 16px: below that, iOS Safari zooms the page on focus.
                fontSize: 'var(--text-body)',
                outline: 'none',
                resize: 'vertical',
                lineHeight: 1.6,
                fontFamily: 'inherit',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-brand-primary)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Topic Image */}
          <div>
            <label
              style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
            >
              {t('editTopicPage.topicImageLabel')}{' '}
              <span style={{ fontSize: 'var(--text-body)', color: 'var(--muted)' }}>{t('editTopicPage.optional')}</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
              {imagePreview && !removeImage ? (
                <div style={{ position: 'relative' }}>
                  <img
                    src={imagePreview}
                    alt={t('editTopicPage.previewAlt')}
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: '50%',
                      objectFit: 'cover',
                      border: '2px solid var(--color-border-default)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setImageFile(null);
                      setImagePreview(null);
                      setRemoveImage(true);
                    }}
                    aria-label={t('editTopicPage.removeImageAria')}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: 'var(--color-status-danger)',
                      color: 'var(--color-text-inverted)',
                      border: 'none',
                      fontSize: 'var(--text-body-sm)',
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
                    border: '2px dashed var(--color-bg-tertiary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: 28,
                    color: 'var(--color-text-tertiary)',
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
              <div style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', lineHeight: 1.6 }}>
                {t('editTopicPage.imageHint.line1')}
                <br />
                {t('editTopicPage.imageHint.line2')}
              </div>
            </div>
          </div>

          {error && (
            <p style={{ color: 'var(--color-status-danger)', fontSize: 'var(--text-body-sm)' }}>{error}</p>
          )}

          {/* Submit */}
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <button
              type="submit"
              disabled={!title.trim() || submitting}
              style={{
                flex: 1,
                background: !title.trim() || submitting ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--accent)',
                color: 'var(--color-text-inverted)',
                border: 'none',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-3) 0',
                fontSize: 'var(--text-body)',
                fontWeight: 700,
                cursor: !title.trim() || submitting ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {imageUploading ? t('editTopicPage.uploadingImage') : submitting ? t('editTopicPage.saving') : t('editTopicPage.saveChanges')}
            </button>
            <Link
              href={`/topics/${topicId}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 'var(--space-3) var(--space-5)',
                fontSize: 'var(--text-body)',
                fontWeight: 600,
                color: 'var(--muted)',
                background: 'var(--color-bg-tertiary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-control)',
                textDecoration: 'none',
                transition: 'all 0.12s',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {t('common.cancel')}
            </Link>
          </div>
        </form>
      </div>
    </CommunityLayout>
  );
}
