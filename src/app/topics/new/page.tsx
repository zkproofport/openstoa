'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import ProofGate from '@/components/ProofGate';
import { resizeImage } from '@/lib/utils';

export default function NewTopicPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [proofType, setProofType] = useState<'none' | 'kyc' | 'country' | 'google_workspace' | 'microsoft_365' | 'workspace'>('none');
  // Workspace provider selection (for affiliation proof)
  const [workspaceGoogle, setWorkspaceGoogle] = useState(false);
  const [workspaceMs, setWorkspaceMs] = useState(false);
  const [countryCodes, setCountryCodes] = useState('');
  const [countryMode, setCountryMode] = useState<'include' | 'exclude'>('include');
  const [requiredDomain, setRequiredDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private' | 'secret'>('public');
  const [imageUploading, setImageUploading] = useState(false);
  const [categories, setCategories] = useState<{id: string; name: string; slug: string; icon: string; description?: string}[]>([]);
  const [categoryId, setCategoryId] = useState<string>('');

  // Proof data state (shared across all proof types: kyc, country, workspace)
  const [proofData, setProofData] = useState<{
    proof: string;
    publicInputs: string[];
    circuit: string;
  } | null>(null);
  const [proofDone, setProofDone] = useState(false);
  // Key to force ProofGate remount when proof params change
  const [proofGateKey, setProofGateKey] = useState(0);

  // Reset proof when country settings change
  useEffect(() => {
    if (proofType === 'country') {
      setProofData(null);
      setProofDone(false);
      setProofGateKey((k) => k + 1);
    }
  // Only reset when the actual filter values change, not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryMode]);

  // Fetch categories on mount
  useEffect(() => {
    fetch('/api/categories')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.categories) setCategories(data.categories); })
      .catch(() => {});
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

  const parsedCountries = countryCodes
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    setError(null);

    let allowedCountries: string[] | undefined;
    if (proofType === 'country' && countryCodes.trim()) {
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
      } catch {
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
          categoryId: categoryId || undefined,
          proofType,
          requiresCountryProof: proofType === 'country',
          allowedCountries,
          countryMode: proofType === 'country' ? countryMode : undefined,
          requiredDomain: (proofType === 'google_workspace' || proofType === 'microsoft_365' || proofType === 'workspace') ? (requiredDomain.trim() || undefined) : undefined,
          image: imageUrl,
          visibility,
          ...(proofData ? { proof: proofData.proof, publicInputs: proofData.publicInputs, circuit: proofData.circuit } : {}),
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

  const needsProof = proofType !== 'none';
  const canSubmit = title.trim().length > 0 && categoryId !== '' && !loading && (!needsProof || proofDone);

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '40px 1.5rem 80px' }}>
        <h1
          style={{
            fontSize: 32,
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
              style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
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

          {/* Category */}
          <div>
            <label style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 10 }}>
              Category <span style={{ color: '#ef4444' }}>*</span>
            </label>
            {categories.length === 0 ? (
              <p style={{ fontSize: 14, color: 'var(--muted)' }}>Loading categories…</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {categories.map((cat) => {
                  const selected = categoryId === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setCategoryId(cat.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 14px',
                        background: selected ? 'rgba(120,140,255,0.08)' : 'var(--surface)',
                        border: `1px solid ${selected ? 'rgba(120,140,255,0.3)' : 'var(--border)'}`,
                        borderRadius: 8,
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        textAlign: 'left',
                      }}
                    >
                      {cat.icon && (
                        <span style={{ fontSize: 20, flexShrink: 0 }}>{cat.icon}</span>
                      )}
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>{cat.name}</div>
                        {cat.description && (
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{cat.description}</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
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
                      fontSize: 14,
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
                    fontSize: 14,
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
              <div style={{ fontSize: 14, color: '#4b5563', lineHeight: 1.5 }}>
                Displayed as topic avatar.
                <br />
                Auto-resized to 400×400 WebP.
              </div>
            </div>
          </div>

          {/* Visibility */}
          <div>
            <label
              style={{ fontSize: 15, color: 'var(--muted)', display: 'block', marginBottom: 10 }}
            >
              Visibility
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                { value: 'public' as const, label: 'Public', desc: 'Anyone can find and join', disabled: false },
                { value: 'private' as const, label: 'Private', desc: 'Visible to all, requires approval to join', disabled: true },
                { value: 'secret' as const, label: 'Secret', desc: 'Hidden, invite code only', disabled: true },
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
                    cursor: opt.disabled ? 'not-allowed' : 'pointer',
                    transition: 'all 0.12s',
                    opacity: opt.disabled ? 0.5 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="visibility"
                    value={opt.value}
                    checked={visibility === opt.value}
                    onChange={() => { if (!opt.disabled) setVisibility(opt.value); }}
                    disabled={opt.disabled}
                    style={{ marginTop: 2, accentColor: 'var(--accent)' }}
                  />
                  <div>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {opt.label}
                      {opt.value === 'private' && ' \uD83D\uDD12'}
                      {opt.value === 'secret' && ' \uD83D\uDC7B'}
                    </span>
                    {opt.disabled && (
                      <span style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: '#f59e0b',
                        background: 'rgba(245,158,11,0.1)',
                        border: '1px solid rgba(245,158,11,0.2)',
                        borderRadius: 4,
                        padding: '1px 6px',
                        marginLeft: 8,
                      }}>
                        Coming Soon
                      </span>
                    )}
                    <p style={{ fontSize: 14, color: 'var(--muted)', margin: '2px 0 0' }}>
                      {opt.desc}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Proof requirement */}
          <div
            style={{
              padding: '16px 20px',
              background: 'var(--surface, #0c0e18)',
              border: `1px solid ${proofType !== 'none' ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
              borderRadius: 12,
              transition: 'border-color 0.15s',
            }}
          >
            <label
              htmlFor="proofType"
              style={{ fontSize: 14, color: 'var(--muted)', display: 'block', marginBottom: 8 }}
            >
              Proof Requirement
            </label>
            <select
              id="proofType"
              value={proofType === 'workspace' || proofType === 'google_workspace' || proofType === 'microsoft_365' ? 'affiliation' : proofType}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'affiliation') {
                  // Default to workspace (both providers)
                  setProofType('workspace');
                  setWorkspaceGoogle(false);
                  setWorkspaceMs(false);
                } else {
                  setProofType(val as 'none' | 'kyc' | 'country');
                  setWorkspaceGoogle(false);
                  setWorkspaceMs(false);
                }
                // Reset proof state on any proof type change
                setProofData(null);
                setProofDone(false);
                setProofGateKey((k) => k + 1);
                if (val !== 'affiliation') {
                  setRequiredDomain('');
                }
              }}
              style={{
                width: '100%',
                background: 'rgba(5,10,8,0.9)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 12px',
                color: 'var(--foreground)',
                fontSize: 14,
                outline: 'none',
                cursor: 'pointer',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                paddingRight: 32,
              }}
            >
              <option value="none">No proof required</option>
              <option value="kyc">Coinbase KYC verification</option>
              <option value="country">Coinbase Country attestation</option>
              <option value="affiliation">Affiliation proof (Organization)</option>
            </select>

            {proofType === 'country' && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Include / Exclude toggle */}
                <div>
                  <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 8 }}>
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
                          fontSize: 15,
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
                    style={{ fontSize: 14, color: 'var(--muted)', display: 'block', marginBottom: 6 }}
                  >
                    ISO country codes (comma-separated)
                  </label>
                  <input
                    id="countries"
                    type="text"
                    value={countryCodes}
                    onChange={(e) => {
                      setCountryCodes(e.target.value);
                      // Reset proof when country codes change
                      if (proofDone) {
                        setProofData(null);
                        setProofDone(false);
                        setProofGateKey((k) => k + 1);
                      }
                    }}
                    placeholder="US, KR, JP, DE"
                    style={{
                      width: '100%',
                      background: '#0a0a0a',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '10px 12px',
                      color: 'var(--foreground)',
                      fontSize: 15,
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
                              fontSize: 15,
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
                    <ProofGate
                      key={proofGateKey}
                      circuitType="coinbase_country_attestation"
                      scope="zkproofport-community"
                      countryList={parsedCountries}
                      isIncluded={countryMode === 'include'}
                      mode="proof"
                      autoStart={false}
                      qrSize={200}
                      label="Scan with ZKProofport app to prove your country"
                      onProofData={({ proof, publicInputs, circuit }) => {
                        setProofData({ proof, publicInputs, circuit });
                        setProofDone(true);
                      }}
                    />
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
                    <span style={{ fontSize: 15, color: '#22c55e', fontWeight: 500 }}>Country proof verified</span>
                  </div>
                )}
              </div>
            )}

            {proofType === 'kyc' && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {!proofDone && (
                  <div style={{
                    padding: '16px',
                    background: '#0a0a0a',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    textAlign: 'center',
                  }}>
                    <ProofGate
                      key={proofGateKey}
                      circuitType="coinbase_attestation"
                      scope="zkproofport-community"
                      mode="proof"
                      autoStart={false}
                      qrSize={200}
                      label="Scan with ZKProofport app to verify KYC"
                      onProofData={({ proof, publicInputs, circuit }) => {
                        setProofData({ proof, publicInputs, circuit });
                        setProofDone(true);
                      }}
                    />
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
                    <span style={{ fontSize: 15, color: '#22c55e', fontWeight: 500 }}>KYC proof verified</span>
                  </div>
                )}
              </div>
            )}

            {(proofType === 'workspace' || proofType === 'google_workspace' || proofType === 'microsoft_365') && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Provider selection */}
                <div>
                  <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 8 }}>
                    Accepted providers
                  </p>
                  <div className="flex gap-3">
                    <label style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 14px',
                      background: workspaceGoogle ? 'rgba(59,130,246,0.06)' : '#111',
                      border: `1px solid ${workspaceGoogle ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'all 0.12s',
                      fontSize: 14,
                    }}>
                      <input
                        type="checkbox"
                        checked={workspaceGoogle}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setWorkspaceGoogle(checked);
                          // Derive proofType from checkbox state
                          if (checked && !workspaceMs) setProofType('google_workspace');
                          else if (!checked && workspaceMs) setProofType('microsoft_365');
                          else setProofType('workspace'); // both or neither = workspace
                        }}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      Google Workspace
                    </label>
                    <label style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 14px',
                      background: workspaceMs ? 'rgba(59,130,246,0.06)' : '#111',
                      border: `1px solid ${workspaceMs ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'all 0.12s',
                      fontSize: 14,
                    }}>
                      <input
                        type="checkbox"
                        checked={workspaceMs}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setWorkspaceMs(checked);
                          // Derive proofType from checkbox state
                          if (checked && !workspaceGoogle) setProofType('microsoft_365');
                          else if (!checked && workspaceGoogle) setProofType('google_workspace');
                          else setProofType('workspace'); // both or neither = workspace
                        }}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      Microsoft 365
                    </label>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
                    {!workspaceGoogle && !workspaceMs
                      ? 'Both providers accepted (Google Workspace or Microsoft 365)'
                      : workspaceGoogle && workspaceMs
                      ? 'Both providers accepted (Google Workspace or Microsoft 365)'
                      : workspaceGoogle
                      ? 'Only Google Workspace accounts accepted'
                      : 'Only Microsoft 365 accounts accepted'}
                  </p>
                </div>

                {/* Domain input (optional) */}
                <div>
                  <label
                    htmlFor="requiredDomain"
                    style={{ fontSize: 14, color: 'var(--muted)', display: 'block', marginBottom: 6 }}
                  >
                    Domain restriction{' '}
                    <span style={{ fontSize: 13, color: 'var(--muted)' }}>(optional)</span>
                  </label>
                  <input
                    id="requiredDomain"
                    type="text"
                    value={requiredDomain}
                    onChange={(e) => {
                      setRequiredDomain(e.target.value);
                      // Reset proof when domain changes
                      if (proofDone) {
                        setProofData(null);
                        setProofDone(false);
                        setProofGateKey((k) => k + 1);
                      }
                    }}
                    placeholder="company.com"
                    style={{
                      width: '100%',
                      background: '#0a0a0a',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '10px 12px',
                      color: 'var(--foreground)',
                      fontSize: 14,
                      outline: 'none',
                      fontFamily: 'monospace',
                      letterSpacing: '0.04em',
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                  />
                  <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
                    {requiredDomain.trim()
                      ? 'Only members with this email domain can join'
                      : 'Leave empty to allow any organization domain'}
                  </p>
                </div>

                {/* Workspace proof verification */}
                {!proofDone && (
                  <div style={{
                    padding: '16px',
                    background: '#0a0a0a',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    textAlign: 'center',
                  }}>
                    <ProofGate
                      key={proofGateKey}
                      circuitType="oidc_domain_attestation"
                      scope="zkproofport-community"
                      domain={requiredDomain.trim() || undefined}
                      mode="proof"
                      autoStart={false}
                      qrSize={200}
                      label="Scan with ZKProofport app to verify your organization"
                      onProofData={({ proof, publicInputs, circuit }) => {
                        setProofData({ proof, publicInputs, circuit });
                        setProofDone(true);
                      }}
                    />
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
                    <span style={{ fontSize: 15, color: '#22c55e', fontWeight: 500 }}>Organization proof verified</span>
                  </div>
                )}
              </div>
            )}

            {proofType !== 'none' && (
              <div style={{
                marginTop: 16,
                padding: '12px 16px',
                background: 'rgba(59,130,246,0.05)',
                border: '1px solid rgba(59,130,246,0.15)',
                borderRadius: 8,
                fontSize: 13,
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}>
                <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>Privacy:</span>{' '}
                Proof verification is privacy-preserving. Only a hashed verification status is
                cached for 30 days — no email, domain, or country is stored in the database.
                Members who already verified within 30 days can join without re-proving.
              </div>
            )}
          </div>

          {error && (
            <p
              style={{
                fontSize: 15,
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
    </CommunityLayout>
  );
}
