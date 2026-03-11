'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '@/components/Header';
import Avatar from '@/components/Avatar';

const NICKNAME_RE = /^[a-zA-Z0-9_]{2,20}$/;

function resizeImage(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round((height / width) * maxSize);
          width = maxSize;
        } else {
          width = Math.round((width / height) * maxSize);
          height = maxSize;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
        'image/webp',
        0.85,
      );
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfilePageInner />
    </Suspense>
  );
}

function ProfilePageInner() {
  const router = useRouter();
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
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
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
      setError('Image must be under 10MB');
      return;
    }
    setImageUploading(true);
    setError(null);
    try {
      const resized = await resizeImage(file, 200);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'avatar.webp', contentType: 'image/webp', size: resized.size, purpose: 'avatar' }),
      });
      if (!res.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, publicUrl } = await res.json();
      const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: resized });
      if (!uploadRes.ok) throw new Error('Failed to upload image');
      const saveRes = await fetch('/api/profile/image', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: publicUrl }),
      });
      if (!saveRes.ok) throw new Error('Failed to save profile image');
      setProfileImage(publicUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setImageUploading(false);
    }
  }

  async function handleImageRemove() {
    setImageUploading(true);
    try {
      const res = await fetch('/api/profile/image', { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove image');
      setProfileImage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove image');
    } finally {
      setImageUploading(false);
    }
  }

  function validate(value: string): string | null {
    if (value.length < 2) return 'Minimum 2 characters';
    if (value.length > 20) return 'Maximum 20 characters';
    if (!NICKNAME_RE.test(value)) return 'Only letters, numbers, and underscore allowed';
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
        throw new Error(d.error ?? 'Failed to set nickname');
      }

      router.replace(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const isValid = nickname.length >= 2 && !validationError;

  return (
    <>
      <Header />
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 0',
        }}
      >
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div style={{ marginBottom: 32 }}>
            <h1
              style={{
                fontSize: 28,
                fontWeight: 800,
                letterSpacing: '-0.04em',
                margin: 0,
              }}
            >
              Choose a nickname
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8 }}>
              Your public identity in ZK Community. You can&apos;t change this later.
            </p>
          </div>

          {userId && (
            <div
              style={{
                padding: '10px 14px',
                background: '#111',
                border: '1px solid var(--border)',
                borderRadius: 8,
                marginBottom: 24,
              }}
            >
              <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0, fontFamily: 'monospace' }}>
                Your verified identity
              </p>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--foreground)',
                  margin: '4px 0 0',
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 4 }}>
              {profileImage ? (
                <div style={{ position: 'relative' }}>
                  <Avatar src={profileImage} name={nickname || 'U'} size={80} />
                  <button
                    type="button"
                    onClick={handleImageRemove}
                    disabled={imageUploading}
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
                      fontSize: 12,
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
                    fontSize: 11,
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
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 4 }}>
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  <span>{imageUploading ? 'Uploading...' : 'Upload\nPhoto'}</span>
                </label>
              )}
              <div style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.5 }}>
                Profile photo (optional)
                <br />
                Auto-resized to 200x200 WebP.
              </div>
            </div>

            <div>
              <label
                htmlFor="nickname"
                style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
              >
                Nickname
              </label>
              <input
                id="nickname"
                type="text"
                value={nickname}
                onChange={handleChange}
                placeholder="e.g. zk_dev_42"
                maxLength={20}
                autoFocus
                style={{
                  width: '100%',
                  background: '#111',
                  border: `1px solid ${validationError ? '#ef4444' : isValid && nickname ? '#22c55e' : 'var(--border)'}`,
                  borderRadius: 8,
                  padding: '12px 14px',
                  color: 'var(--foreground)',
                  fontSize: 15,
                  outline: 'none',
                  fontFamily: 'monospace',
                  transition: 'border-color 0.15s',
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
                  <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>{validationError}</p>
                ) : isValid && nickname ? (
                  <p style={{ fontSize: 12, color: '#22c55e', margin: 0 }}>Looks good</p>
                ) : (
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                    Letters, numbers, underscores only
                  </p>
                )}
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                  {nickname.length}/20
                </p>
              </div>
            </div>

            {error && (
              <p
                style={{
                  fontSize: 13,
                  color: '#ef4444',
                  margin: 0,
                  fontFamily: 'monospace',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 6,
                  padding: '8px 12px',
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
                borderRadius: 8,
                padding: '12px',
                fontSize: 15,
                fontWeight: 600,
                cursor: isValid ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              {loading ? 'Setting up...' : 'Continue →'}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
