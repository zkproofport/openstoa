'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/Header';

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

export default function NewTopicPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requiresCountry, setRequiresCountry] = useState(false);
  const [countryCodes, setCountryCodes] = useState('');
  const [countryMode, setCountryMode] = useState<'include' | 'exclude'>('include');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private' | 'secret'>('public');
  const [imageUploading, setImageUploading] = useState(false);

  // Country proof state
  const [countryProofData, setCountryProofData] = useState<{
    proof: string;
    publicInputs: string[];
  } | null>(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofDone, setProofDone] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(false);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

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
  }

  async function startCountryProof() {
    setProofLoading(true);
    setError(null);
    try {
      const parsedCountries = countryCodes
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      const res = await fetch('/api/auth/proof-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circuitType: 'coinbase_country_attestation',
          scope: 'zkproofport-community',
          countryList: parsedCountries,
          isIncluded: countryMode === 'include',
        }),
      });
      if (!res.ok) throw new Error('Failed to create proof request');
      const data = await res.json();
      setDeepLink(data.deepLink);

      const QRCode = await import('qrcode');
      const url = await QRCode.toDataURL(data.deepLink, {
        width: 224,
        margin: 2,
        color: { dark: '#ededed', light: '#0a0a0a' },
      });
      setQrDataUrl(url);

      doneRef.current = false;
      pollingRef.current = setInterval(async () => {
        if (doneRef.current) return;
        try {
          const pollRes = await fetch(`/api/auth/poll/${data.requestId}?mode=proof`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          if (pollData.status === 'completed' && pollData.proof && pollData.publicInputs) {
            doneRef.current = true;
            if (pollingRef.current) clearInterval(pollingRef.current);
            setCountryProofData({
              proof: pollData.proof,
              publicInputs: pollData.publicInputs,
            });
            setProofDone(true);
            setProofLoading(false);
          }
        } catch {
          // Retry silently
        }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start proof');
      setProofLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    setError(null);

    let allowedCountries: string[] | undefined;
    if (requiresCountry && countryCodes.trim()) {
      allowedCountries = countryCodes
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length === 2);
    }

    let imageUrl: string | undefined;
    if (imageFile) {
      setImageUploading(true);
      try {
        imageUrl = await uploadTopicImage(imageFile);
      } catch (err) {
        setError('Failed to upload image');
        setLoading(false);
        setImageUploading(false);
        return;
      }
      setImageUploading(false);
    }

    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          requiresCountryProof: requiresCountry,
          allowedCountries,
          countryMode: requiresCountry ? countryMode : undefined,
          image: imageUrl,
          visibility,
          ...(countryProofData ? { proof: countryProofData.proof, publicInputs: countryProofData.publicInputs } : {}),
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Failed to create topic');
      }

      const data = await res.json();
      router.push(`/topics/${data.topic.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }

  const canSubmit = title.trim().length > 0 && !loading && (!requiresCountry || proofDone);

  return (
    <>
      <Header />
      <div style={{ paddingTop: 40, paddingBottom: 80, maxWidth: 560 }}>
        <div style={{ marginBottom: 32, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link
            href="/topics"
            style={{
              color: 'var(--muted)',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            ← Topics
          </Link>
          <span style={{ color: 'var(--border)' }}>/</span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>New</span>
        </div>

        <h1
          style={{
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: '0 0 28px',
          }}
        >
          Create Topic
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Title */}
          <div>
            <label
              htmlFor="title"
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Title <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. DeFi strategies for KYC-verified users"
              maxLength={100}
              autoFocus
              style={{
                width: '100%',
                background: '#111',
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
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Description{' '}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>(optional)</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this topic about?"
              rows={3}
              style={{
                width: '100%',
                background: '#111',
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
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Topic Image{' '}
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>(optional)</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {imagePreview ? (
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
                      fontSize: 12,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      lineHeight: 1,
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
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    color: 'var(--muted)',
                    fontSize: 12,
                    textAlign: 'center',
                    lineHeight: 1.3,
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(59,130,246,0.4)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.15)';
                  }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    style={{ display: 'none' }}
                  />
                  <span>
                    Add
                    <br />
                    Image
                  </span>
                </label>
              )}
              <div style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.5 }}>
                Displayed as topic avatar.
                <br />
                Auto-resized to 400×400 WebP.
              </div>
            </div>
          </div>

          {/* Visibility */}
          <div>
            <label
              style={{ fontSize: 13, color: 'var(--muted)', display: 'block', marginBottom: 10 }}
            >
              Visibility
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                { value: 'public' as const, label: 'Public', desc: 'Anyone can find and join' },
                { value: 'private' as const, label: 'Private', desc: 'Visible to all, requires approval to join' },
                { value: 'secret' as const, label: 'Secret', desc: 'Hidden, invite code only' },
              ]).map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 14px',
                    background: visibility === opt.value ? 'rgba(59,130,246,0.06)' : '#111',
                    border: `1px solid ${visibility === opt.value ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                  }}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value={opt.value}
                    checked={visibility === opt.value}
                    onChange={() => setVisibility(opt.value)}
                    style={{ marginTop: 2, accentColor: 'var(--accent)' }}
                  />
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {opt.label}
                      {opt.value === 'private' && ' \uD83D\uDD12'}
                      {opt.value === 'secret' && ' \uD83D\uDC7B'}
                    </span>
                    <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>
                      {opt.desc}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Country gating */}
          <div
            style={{
              padding: '16px 20px',
              background: '#111',
              border: `1px solid ${requiresCountry ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
              borderRadius: 12,
              transition: 'border-color 0.15s',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={requiresCountry}
                onChange={(e) => {
                  setRequiresCountry(e.target.checked);
                  if (!e.target.checked) {
                    setCountryProofData(null);
                    setProofDone(false);
                    setProofLoading(false);
                    setDeepLink(null);
                    setQrDataUrl(null);
                    if (pollingRef.current) clearInterval(pollingRef.current);
                  }
                }}
                style={{
                  width: 16,
                  height: 16,
                  accentColor: 'var(--accent)',
                  cursor: 'pointer',
                }}
              />
              <div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Require Country Proof</span>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0' }}>
                  Members must provide a ZK proof of their country via Coinbase attestation
                </p>
              </div>
            </label>

            {requiresCountry && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Include / Exclude toggle */}
                <div>
                  <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                    Country filter mode
                  </p>
                  <div className="flex gap-2">
                    {(['include', 'exclude'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCountryMode(mode)}
                        style={{
                          background: countryMode === mode ? 'var(--accent)' : 'var(--border)',
                          color: countryMode === mode ? '#fff' : 'var(--muted)',
                          border: 'none',
                          borderRadius: 6,
                          padding: '6px 16px',
                          fontSize: 13,
                          cursor: 'pointer',
                          fontWeight: countryMode === mode ? 600 : 400,
                          transition: 'all 0.12s',
                        }}
                      >
                        {mode === 'include' ? 'Allow only' : 'Block'}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="countries"
                    style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 6 }}
                  >
                    ISO country codes (comma-separated)
                  </label>
                  <input
                    id="countries"
                    type="text"
                    value={countryCodes}
                    onChange={(e) => setCountryCodes(e.target.value)}
                    placeholder="US, KR, JP, DE"
                    style={{
                      width: '100%',
                      background: '#0a0a0a',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '10px 12px',
                      color: 'var(--foreground)',
                      fontSize: 13,
                      outline: 'none',
                      fontFamily: 'monospace',
                      letterSpacing: '0.04em',
                    }}
                  />
                  {countryCodes && (
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {countryCodes
                        .split(',')
                        .map((s) => s.trim().toUpperCase())
                        .filter((s) => s.length > 0)
                        .map((code, i) => (
                          <span
                            key={i}
                            style={{
                              fontSize: 11,
                              fontFamily: 'monospace',
                              background:
                                code.length === 2
                                  ? 'rgba(34,197,94,0.1)'
                                  : 'rgba(239,68,68,0.1)',
                              color: code.length === 2 ? '#22c55e' : '#ef4444',
                              border: `1px solid ${code.length === 2 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                              padding: '2px 6px',
                              borderRadius: 4,
                            }}
                          >
                            {code}
                          </span>
                        ))}
                    </div>
                  )}
                </div>

                {/* Country proof verification */}
                {!proofDone && (
                  <div style={{
                    padding: '16px',
                    background: '#0a0a0a',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    textAlign: 'center',
                  }}>
                    {!qrDataUrl && !proofLoading && (
                      <button
                        type="button"
                        onClick={startCountryProof}
                        style={{
                          background: 'var(--accent)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 8,
                          padding: '10px 24px',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Verify Your Country
                      </button>
                    )}
                    {qrDataUrl && (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
                          Scan with ZKProofport app to prove your country
                        </p>
                        <div style={{
                          padding: 12,
                          background: '#0a0a0a',
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                        }}>
                          <img src={qrDataUrl} alt="Country proof QR" width={200} height={200} style={{ display: 'block', borderRadius: 8 }} />
                        </div>
                        {deepLink && (
                          <a href={deepLink} style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none', fontFamily: 'monospace' }}>
                            Open in ZKProofport app →
                          </a>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" style={{ animation: 'spin 1s linear infinite' }}>
                            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                          </svg>
                          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Waiting for proof...</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {proofDone && (
                  <div style={{
                    padding: '12px 16px',
                    background: 'rgba(34,197,94,0.08)',
                    border: '1px solid rgba(34,197,94,0.25)',
                    borderRadius: 10,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <span style={{ color: '#22c55e', fontSize: 18 }}>✓</span>
                    <span style={{ fontSize: 13, color: '#22c55e', fontWeight: 500 }}>Country proof verified</span>
                  </div>
                )}
              </div>
            )}
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

          <div className="flex gap-3">
            <Link
              href="/topics"
              style={{
                flex: 1,
                textAlign: 'center',
                padding: '12px',
                background: 'var(--border)',
                color: 'var(--muted)',
                textDecoration: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={!canSubmit || imageUploading}
              style={{
                flex: 2,
                background: canSubmit && !imageUploading ? 'var(--accent)' : 'var(--border)',
                color: canSubmit && !imageUploading ? '#fff' : 'var(--muted)',
                border: 'none',
                borderRadius: 8,
                padding: '12px',
                fontSize: 14,
                fontWeight: 600,
                cursor: canSubmit && !imageUploading ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
              }}
            >
              {imageUploading ? 'Uploading image...' : loading ? 'Creating...' : 'Create Topic'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
