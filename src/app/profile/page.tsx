'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/Header';
import Avatar from '@/components/Avatar';
import { resizeImage } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n/I18nProvider';

const NICKNAME_RE = /^[a-zA-Z0-9_]{2,20}$/;

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfilePageInner />
    </Suspense>
  );
}

function ProfilePageInner() {
  const router = useRouter();
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') ?? '/topics';
  const [nickname, setNickname] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!data?.userId) {
          router.replace('/');
          return;
        }
        if (data.nickname && !data.nickname.startsWith('anon_')) {
          router.replace(returnTo);
          return;
        }
        setUserId(data.userId ?? null);
        if (data.profileImage) setProfileImage(data.profileImage);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  async function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      setError(t('profilePage.imageTooLarge'));
      return;
    }
    setImageUploading(true);
    setError(null);
    try {
      const resized = await resizeImage(file, 200);
      const form = new FormData();
      form.append('file', new File([resized], 'avatar.webp', { type: 'image/webp' }));
      form.append('purpose', 'avatar');
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(t('profilePage.uploadImageFailed'));
      const { publicUrl } = (await res.json()) as { publicUrl: string };
      const saveRes = await fetch('/api/profile/image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: publicUrl }),
      });
      if (!saveRes.ok) throw new Error(t('profilePage.saveImageFailed'));
      setProfileImage(publicUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profilePage.uploadFailed'));
    } finally {
      setImageUploading(false);
    }
  }

  async function handleImageRemove() {
    setImageUploading(true);
    try {
      const res = await fetch('/api/profile/image', { method: 'DELETE' });
      if (!res.ok) throw new Error(t('profilePage.removeImageFailed'));
      setProfileImage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profilePage.removeImageFailed'));
    } finally {
      setImageUploading(false);
    }
  }

  function validate(value: string): string | null {
    if (value.length < 2) return t('profilePage.validation.min');
    if (value.length > 20) return t('profilePage.validation.max');
    if (!NICKNAME_RE.test(value)) return t('profilePage.validation.charset');
    return null;
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setNickname(val);
    setValidationError(val ? validate(val) : null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate(nickname);
    if (v) {
      setValidationError(v);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/profile/nickname', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('profilePage.setNicknameFailed'));
      }

      router.replace(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profilePage.unknownError'));
    } finally {
      setLoading(false);
    }
  }

  const isValid = nickname.length >= 2 && !validationError;

  return (
    <>
      <Header />
      {/* 73px = standalone <Header /> rendered height (see recovery/page.tsx comment). */}
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px var(--space-5)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div style={{ marginBottom: 'var(--space-6)' }}>
            <h1
              style={{
                fontSize: 'var(--text-heading-lg)',
                fontWeight: 800,
                letterSpacing: '-0.04em',
                margin: 0,
              }}
            >
              {t('profilePage.title')}
            </h1>
            <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', marginTop: 'var(--space-2)' }}>
              {t('profilePage.subtitle')}
            </p>
          </div>

          {userId && (
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--surface, #0c0e18)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-control)',
                marginBottom: 'var(--space-5)',
              }}
            >
              <p style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', margin: 0, fontFamily: 'monospace' }}>
                {t('profilePage.verifiedIdentity')}
              </p>
              <p
                style={{
                  fontSize: 'var(--text-body)',
                  color: 'var(--foreground)',
                  margin: 'var(--space-1) 0 0',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                }}
              >
                {userId.slice(0, 8)}...{userId.slice(-6)}
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Profile Image Upload */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', marginBottom: 'var(--space-1)' }}>
              {profileImage ? (
                <div style={{ position: 'relative' }}>
                  <Avatar src={profileImage} name={nickname || 'U'} size={80} />
                  <button
                    type="button"
                    onClick={handleImageRemove}
                    disabled={imageUploading}
                    aria-label={t('profilePage.removePhoto')}
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
                      fontSize: 'var(--text-body-sm)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
                      opacity: imageUploading ? 0.5 : 1,
                    }}
                  >
                    ×
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
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: imageUploading ? 'wait' : 'pointer',
                    color: 'var(--muted)',
                    fontSize: 'var(--text-body)',
                    textAlign: 'center',
                    lineHeight: 1.3,
                    transition: 'border-color 0.15s',
                    flexShrink: 0,
                    opacity: imageUploading ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,130,246,0.4)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)'; }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    disabled={imageUploading}
                    style={{ display: 'none' }}
                  />
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 'var(--space-1)' }}>
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span>{imageUploading ? t('profilePage.uploading') : t('profilePage.uploadPhoto')}</span>
                </label>
              )}
              <div style={{ fontSize: 'var(--text-body-sm)', color: '#4b5563', lineHeight: 1.5 }}>
                {t('profilePage.photoHelp.line1')}
                <br />
                {t('profilePage.photoHelp.line2')}
              </div>
            </div>

            <div>
              <label
                htmlFor="nickname"
                style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
              >
                {t('profilePage.nicknameLabel')}
              </label>
              <input
                id="nickname"
                type="text"
                value={nickname}
                onChange={handleChange}
                placeholder={t('profilePage.nicknamePlaceholder')}
                maxLength={20}
                autoFocus
                style={{
                  width: '100%',
                  background: 'var(--surface, #0c0e18)',
                  border: `1px solid ${validationError ? '#ef4444' : isValid && nickname ? '#22c55e' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-control)',
                  padding: 'var(--space-3) 14px',
                  color: 'var(--foreground)',
                  // var(--text-body) = 16px: below that, iOS Safari zooms the page on focus.
                  fontSize: 'var(--text-body)',
                  outline: 'none',
                  fontFamily: 'var(--font-mono)',
                  transition: 'border-color 0.15s',
                  minHeight: 'var(--touch-target-min)',
                  boxSizing: 'border-box',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: 6,
                }}
              >
                {validationError ? (
                  <p style={{ fontSize: 'var(--text-body-sm)', color: '#ef4444', margin: 0 }}>{validationError}</p>
                ) : isValid && nickname ? (
                  <p style={{ fontSize: 'var(--text-body-sm)', color: '#22c55e', margin: 0 }}>{t('profilePage.looksGood')}</p>
                ) : (
                  <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: 0 }}>
                    {t('profilePage.charsetHint')}
                  </p>
                )}
                <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: 0 }}>
                  {nickname.length}/20
                </p>
              </div>
            </div>

            {error && (
              <p
                style={{
                  fontSize: 'var(--text-body)',
                  color: '#ef4444',
                  margin: 0,
                  fontFamily: 'monospace',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 'var(--radius-control)',
                  padding: 'var(--space-2) var(--space-3)',
                }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={!isValid || loading}
              style={{
                background: isValid ? 'var(--accent)' : 'var(--border)',
                color: isValid ? '#fff' : 'var(--muted)',
                border: 'none',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-3)',
                fontSize: 'var(--text-body)',
                fontWeight: 600,
                cursor: isValid ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {loading ? t('profilePage.settingUp') : t('profilePage.continue')}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
