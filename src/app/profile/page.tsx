'use client';

/**
 * One-time nickname setup, reached straight after the proof-of-identity step
 * and redirected away from once a real nickname exists.
 *
 * Standalone chrome: `<Header />` and nothing else — no `CommunityLayout`, so
 * no sidebar, no tab bar, no chat rail. It is a single-column form that has to
 * stand on its own, so the heading, the identity it is naming, and the one
 * action are the whole page.
 */
import { apiFetch, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
import { useState, useEffect, Suspense } from 'react';
import { isDefaultNickname } from '@/lib/defaultNickname';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/Header';
import Avatar from '@/components/Avatar';
import { resizeImage } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { safeReturnTo, withHash } from '@/lib/returnTo';

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
  // Sanitised and fragment-preserving: this page is a detour on the way back
  // to `returnTo`, and an invite link's history keys are in the fragment. See
  // `lib/returnTo.ts`.
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const backToReturnTo = () => router.replace(withHash(returnTo, window.location.hash));
  const [nickname, setNickname] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);

  /*
   * Acts once the SERVER has answered. A seeded session is a hint, and a
   * redirect should not rest on a hint — the previous code only ever ran after
   * the fetch settled, and a failed lookup settles as `null`.
   */
  const { session, isVerified } = useSession();

  useEffect(() => {
    if (!isVerified) return;
    if (!session?.userId) {
      router.replace('/');
      return;
    }
    if (session.nickname && !isDefaultNickname(session.nickname)) {
      backToReturnTo();
      return;
    }
    setUserId(session.userId ?? null);
    if (session.profileImage) setProfileImage(session.profileImage);
  }, [router, session, isVerified]);

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
      // Upload deadline, not the ordinary one — the clock covers the body.
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: form,
        timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(t('profilePage.uploadImageFailed'));
      const { publicUrl } = (await res.json()) as { publicUrl: string };
      const saveRes = await apiFetch('/api/profile/image', {
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
      const res = await apiFetch('/api/profile/image', { method: 'DELETE' });
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
      const res = await apiFetch('/api/profile/nickname', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('profilePage.setNicknameFailed'));
      }

      backToReturnTo();
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
          padding: 'var(--space-6) var(--space-5) var(--space-7)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 440 }}>
          <h1
            style={{
              fontSize: 'var(--text-heading-lg)',
              fontWeight: 700,
              letterSpacing: '-0.03em',
              color: 'var(--color-text-primary)',
              margin: 0,
            }}
          >
            {t('profilePage.title')}
          </h1>
          <p
            style={{
              fontSize: 'var(--text-body-sm)',
              color: 'var(--color-text-secondary)',
              lineHeight: 'var(--leading-base)',
              maxWidth: '48ch',
              margin: 'var(--space-2) 0 var(--space-6)',
            }}
          >
            {t('profilePage.subtitle')}
          </p>

          {/* The identity this nickname is being attached to — a nullifier, not
              a wallet. Shown so the user can see that naming it changes
              nothing about what the account reveals. */}
          {userId && (
            <div
              style={{
                padding: 'var(--space-3) var(--space-4)',
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-card)',
                marginBottom: 'var(--space-5)',
              }}
            >
              <p className="os-label" style={{ color: 'var(--color-text-tertiary)', margin: 0 }}>
                {t('profilePage.verifiedIdentity')}
              </p>
              <p
                className="os-break-all"
                style={{
                  fontSize: 'var(--text-body-sm)',
                  color: 'var(--color-text-primary)',
                  margin: 'var(--space-1) 0 0',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {userId.slice(0, 8)}...{userId.slice(-6)}
              </p>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {/* Profile Image Upload */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
              {profileImage ? (
                <div style={{ position: 'relative' }}>
                  <Avatar src={profileImage} name={nickname || 'U'} size={72} />
                  <button
                    type="button"
                    onClick={handleImageRemove}
                    disabled={imageUploading}
                    aria-label={t('profilePage.removePhoto')}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      width: 24,
                      height: 24,
                      borderRadius: 'var(--radius-pill)',
                      background: 'var(--color-status-danger)',
                      color: 'var(--color-text-inverted)',
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
                    width: 72,
                    height: 72,
                    borderRadius: 'var(--radius-pill)',
                    border: '2px dashed var(--color-border-default)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: imageUploading ? 'wait' : 'pointer',
                    color: 'var(--color-text-tertiary)',
                    fontSize: 'var(--text-label)',
                    textAlign: 'center',
                    lineHeight: 'var(--leading-tight)',
                    transition: 'border-color 0.15s',
                    flexShrink: 0,
                    opacity: imageUploading ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)'; }}
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
              <div style={{ flex: '1 1 180px', minWidth: 0, fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)', lineHeight: 'var(--leading-base)' }}>
                {t('profilePage.photoHelp.line1')}
                <br />
                {t('profilePage.photoHelp.line2')}
              </div>
            </div>

            <div>
              <label
                htmlFor="nickname"
                style={{
                  display: 'block',
                  fontSize: 'var(--text-body-sm)',
                  fontWeight: 600,
                  color: 'var(--color-text-primary)',
                  marginBottom: 'var(--space-2)',
                }}
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
                  background: 'var(--color-bg-secondary)',
                  border: `1px solid ${validationError ? 'var(--color-status-danger)' : isValid && nickname ? 'var(--color-brand-accent)' : 'var(--color-border-default)'}`,
                  borderRadius: 'var(--radius-control)',
                  padding: '0 var(--space-4)',
                  color: 'var(--color-text-primary)',
                  // var(--text-body) = 16px: below that, iOS Safari zooms the page on focus.
                  fontSize: 'var(--text-body)',
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
                  gap: 'var(--space-3)',
                  marginTop: 'var(--space-2)',
                  fontSize: 'var(--text-caption)',
                }}
              >
                {validationError ? (
                  <p style={{ color: 'var(--color-status-danger)', margin: 0 }}>{validationError}</p>
                ) : isValid && nickname ? (
                  <p style={{ color: 'var(--color-brand-accent)', margin: 0 }}>{t('profilePage.looksGood')}</p>
                ) : (
                  <p style={{ color: 'var(--color-text-tertiary)', margin: 0 }}>
                    {t('profilePage.charsetHint')}
                  </p>
                )}
                <p style={{ color: 'var(--color-text-tertiary)', margin: 0, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                  {nickname.length}/20
                </p>
              </div>
            </div>

            {error && (
              <p
                style={{
                  fontSize: 'var(--text-body-sm)',
                  color: 'var(--color-status-danger)',
                  lineHeight: 'var(--leading-base)',
                  margin: 0,
                  background: 'color-mix(in srgb, var(--color-status-danger) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-status-danger) 20%, transparent)',
                  borderRadius: 'var(--radius-control)',
                  padding: 'var(--space-3) var(--space-4)',
                }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              className={`os-button${isValid ? ' os-button-primary' : ''}`}
              disabled={!isValid || loading}
              style={{
                width: '100%',
                cursor: isValid ? 'pointer' : 'not-allowed',
                opacity: isValid ? 1 : 0.6,
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
