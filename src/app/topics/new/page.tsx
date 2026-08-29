'use client';

import { apiFetch, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import CommunityLayout from '@/components/CommunityLayout';
import ProofGate from '@/components/ProofGate';
import { resizeImage } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import {
  ARCHIVE_RETENTION_CHOICES,
  ARCHIVE_RETENTION_DEFAULT,
  archiveRetentionKey,
  type ArchiveRetentionDays,
} from '@/lib/archiveRetention';

export default function NewTopicPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [proofType, setProofType] = useState<'none' | 'kyc' | 'country' | 'google_workspace' | 'microsoft_365' | 'workspace'>('none');
  // When "Either" is selected, the creator must pick a provider for their own proof
  const [creatorProvider, setCreatorProvider] = useState<'google' | 'microsoft' | null>(null);
  const [countryCodes, setCountryCodes] = useState('');
  const [countryMode, setCountryMode] = useState<'include' | 'exclude'>('include');
  const [requiredDomain, setRequiredDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private' | 'secret'>('public');
  // Chosen here or never: the window cannot be edited afterwards, because
  // shortening one deletes other members' history.
  const [archiveRetentionDays, setArchiveRetentionDays] =
    useState<ArchiveRetentionDays>(ARCHIVE_RETENTION_DEFAULT);
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
    apiFetch('/api/categories')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.categories) return;
        setCategories(data.categories);
        /*
         * Pick the first one, the way the app does.
         *
         * A category is required, and with none chosen the Create button sits
         * greyed out with nothing on screen saying why — the required marker is
         * a red asterisk further up a long form, off screen by the time you
         * reach the button. Watched on 2026-08-29: filled in a title, pressed a
         * dead button, and only found the cause by reading the code. The app
         * has always arrived with General selected.
         */
        setCategoryId((current) => current || data.categories[0]?.id || '');
      })
      .catch(() => {});
  }, []);

  async function uploadTopicImage(file: File): Promise<string> {
    const resized = await resizeImage(file, 400);
    const form = new FormData();
    form.append('file', new File([resized], 'topic-image.webp', { type: 'image/webp' }));
    form.append('purpose', 'topic');

    // Upload deadline, not the ordinary one — the clock covers the body.
    const res = await apiFetch('/api/upload', {
      method: 'POST',
      body: form,
      timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(t('profilePage.uploadImageFailed'));
    const { publicUrl } = (await res.json()) as { publicUrl: string };
    return publicUrl;
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      setError(t('profilePage.imageTooLarge'));
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
        setError(t('profilePage.uploadImageFailed'));
        setLoading(false);
        setImageUploading(false);
        return;
      }
      setImageUploading(false);
    }

    try {
      const res = await apiFetch('/api/topics', {
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
          chatArchiveRetentionDays: archiveRetentionDays,
          ...(proofData ? { proof: proofData.proof, publicInputs: proofData.publicInputs, circuit: proofData.circuit } : {}),
        }),
      });

      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? t('newTopicPage.createFailed'));
      }

      const data = await res.json();
      router.push(`/topics/${data.topic.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('editTopicPage.unknownError'));
      setLoading(false);
    }
  }

  const needsProof = proofType !== 'none';
  const canSubmit = title.trim().length > 0 && categoryId !== '' && !loading && (!needsProof || proofDone);

  return (
    <CommunityLayout isGuest={false} sessionChecked={true}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '40px var(--space-5) 80px' }}>
        <h1
          style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            margin: '0 0 28px',
          }}
        >
          {t('newTopicPage.title')}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {/* Title */}
          <div>
            <label
              htmlFor="title"
              style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
            >
              {t('newTopicPage.titleLabel')} <span style={{ color: 'var(--color-status-danger)' }}>*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('newTopicPage.titlePlaceholder')}
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

          {/* Category */}
          <div>
            <label style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 10 }}>
              {t('newTopicPage.categoryLabel')} <span style={{ color: 'var(--color-status-danger)' }}>*</span>
            </label>
            {categories.length === 0 ? (
              <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)' }}>{t('newTopicPage.loadingCategories')}</p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}>
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
                        background: selected ? 'color-mix(in srgb, var(--color-brand-primary) 8%, transparent)' : 'var(--surface)',
                        border: `1px solid ${selected ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-control)',
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        textAlign: 'left',
                        minHeight: 'var(--touch-target-min)',
                      }}
                    >
                      {cat.icon && (
                        <span style={{ fontSize: 20, flexShrink: 0 }}>{cat.icon}</span>
                      )}
                      <div>
                        <div style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: 'var(--foreground)' }}>{cat.name}</div>
                        {cat.description && (
                          <div style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', marginTop: 2 }}>{cat.description}</div>
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
              {imagePreview ? (
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
                    ×
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
                    color: 'var(--muted)',
                    fontSize: 'var(--text-body-sm)',
                    textAlign: 'center',
                    lineHeight: 1.3,
                    transition: 'border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-brand-primary)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border-default)';
                  }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    style={{ display: 'none' }}
                  />
                  <span>
                    {t('newTopicPage.addImageLine1')}
                    <br />
                    {t('newTopicPage.addImageLine2')}
                  </span>
                </label>
              )}
              <div style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
                {t('newTopicPage.imageHint.line1')}
                <br />
                {t('newTopicPage.imageHint.line2')}
              </div>
            </div>
          </div>

          {/* Visibility */}
          <div>
            <label
              style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 10 }}
            >
              {t('newTopicPage.visibilityLabel')}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {([
                { value: 'public' as const, label: t('newTopicPage.visibility.public.label'), desc: t('newTopicPage.visibility.public.desc'), disabled: false },
                // Secret was held back while its join path — expiring
                // single-use invites only, no permanent code — was new and
                // unexercised, because it is the one tier whose confidentiality
                // rests entirely on join control. That path is now enforced
                // server-side: the invite-join route refuses a permanent code
                // for any non-public topic, so a secret room cannot be entered
                // by a link that outlives its single use. Opening it is what
                // lets it be exercised end to end.
                { value: 'private' as const, label: t('newTopicPage.visibility.private.label'), desc: t('newTopicPage.visibility.private.desc'), disabled: false },
                { value: 'secret' as const, label: t('newTopicPage.visibility.secret.label'), desc: t('newTopicPage.visibility.secret.desc'), disabled: false },
              ]).map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 14px',
                    background: visibility === opt.value ? 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)' : 'var(--color-bg-secondary)',
                    border: `1px solid ${visibility === opt.value ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-control)',
                    cursor: opt.disabled ? 'not-allowed' : 'pointer',
                    transition: 'all 0.12s',
                    opacity: opt.disabled ? 0.5 : 1,
                    minHeight: 'var(--touch-target-min)',
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
                    <span style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600 }}>
                      {opt.label}
                      {opt.value === 'private' && ' \uD83D\uDD12'}
                      {opt.value === 'secret' && ' \uD83D\uDC7B'}
                    </span>
                    {opt.disabled && (
                      <span className="os-label" style={{
                        color: 'var(--color-status-warning)',
                        background: 'color-mix(in srgb, var(--color-status-warning) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--color-status-warning) 20%, transparent)',
                        borderRadius: 'var(--radius-control)',
                        padding: '1px 6px',
                        marginLeft: 'var(--space-2)',
                      }}>
                        {t('newTopicPage.comingSoon')}
                      </span>
                    )}
                    <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '2px 0 0' }}>
                      {opt.desc}
                    </p>
                  </div>
                </label>
              ))}
            </div>
            {/* The visibility choice is also a choice about who can read the
                chat — including whether the service can. That is more than fits
                in a radio label, so it links out at the moment of the decision
                rather than being discovered afterwards. */}
            <Link
              href="/docs/tiers"
              style={{
                display: 'inline-block',
                marginTop: 'var(--space-2)',
                fontSize: 'var(--text-body-sm)',
                color: 'var(--color-brand-primary)',
              }}
            >
              {t('newTopicPage.tiersLink')}
            </Link>
          </div>

          {/* Chat history retention — chosen once, here. The cost of a short
              window is stated next to the choice rather than buried in a help
              page: it deletes for everyone, so a later joiner sees less. */}
          <div>
            <label
              style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-1)' }}
            >
              {t('newTopicPage.archiveRetention.label')}
            </label>
            <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '0 0 10px' }}>
              {t('newTopicPage.archiveRetention.hint')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ARCHIVE_RETENTION_CHOICES.map((days) => {
                const key = archiveRetentionKey(days);
                const selected = archiveRetentionDays === days;
                return (
                  <label
                    key={days}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      padding: '10px 14px',
                      background: selected ? 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)' : 'var(--color-bg-secondary)',
                      border: `1px solid ${selected ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-control)',
                      cursor: 'pointer',
                      transition: 'all 0.12s',
                      minHeight: 'var(--touch-target-min)',
                    }}
                  >
                    <input
                      type="radio"
                      name="chatArchiveRetentionDays"
                      value={days}
                      checked={selected}
                      onChange={() => setArchiveRetentionDays(days)}
                      style={{ marginTop: 2, accentColor: 'var(--accent)' }}
                    />
                    <div>
                      <span style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600 }}>
                        {t(`newTopicPage.archiveRetention.options.${key}.label`)}
                      </span>
                      <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', margin: '2px 0 0' }}>
                        {t(`newTopicPage.archiveRetention.options.${key}.desc`)}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
            <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-warning)', margin: '10px 0 0' }}>
              {t('newTopicPage.archiveRetention.cost')}
            </p>
          </div>

          {/* Proof requirement */}
          <div
            style={{
              padding: '16px var(--space-5)',
              background: 'var(--color-bg-secondary)',
              border: `1px solid ${proofType !== 'none' ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-card)',
              transition: 'border-color 0.15s',
            }}
          >
            <label
              htmlFor="proofType"
              style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', display: 'block', marginBottom: 'var(--space-2)' }}
            >
              {t('newTopicPage.proofRequirementLabel')}
            </label>
            <select
              id="proofType"
              value={proofType === 'workspace' || proofType === 'google_workspace' || proofType === 'microsoft_365' ? 'affiliation' : proofType}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'affiliation') {
                  // Default to google_workspace
                  setProofType('google_workspace');
                } else {
                  setProofType(val as 'none' | 'kyc' | 'country');
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
                background: 'color-mix(in srgb, var(--color-bg-primary) 90%, transparent)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-control)',
                padding: '10px var(--space-3)',
                color: 'var(--foreground)',
                fontSize: 'var(--text-body-sm)',
                outline: 'none',
                cursor: 'pointer',
                appearance: 'none',
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                paddingRight: 32,
                minHeight: 'var(--touch-target-min)',
              }}
            >
              <option value="none">{t('newTopicPage.proofOptions.none')}</option>
              <option value="kyc">{t('newTopicPage.proofOptions.kyc')}</option>
              <option value="country">{t('newTopicPage.proofOptions.country')}</option>
              <option value="affiliation">{t('newTopicPage.proofOptions.affiliation')}</option>
            </select>

            {proofType === 'country' && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Include / Exclude toggle */}
                <div>
                  <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>
                    {t('newTopicPage.countryFilterMode')}
                  </p>
                  <div className="flex gap-2">
                    {(['include', 'exclude'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCountryMode(mode)}
                        style={{
                          background: countryMode === mode ? 'var(--accent)' : 'var(--border)',
                          color: countryMode === mode ? 'var(--color-text-inverted)' : 'var(--muted)',
                          border: 'none',
                          borderRadius: 'var(--radius-control)',
                          padding: '6px var(--space-4)',
                          fontSize: 'var(--text-body)',
                          cursor: 'pointer',
                          fontWeight: countryMode === mode ? 600 : 400,
                          transition: 'all 0.12s',
                          minHeight: 'var(--touch-target-min)',
                        }}
                      >
                        {mode === 'include' ? t('newTopicPage.allowOnly') : t('newTopicPage.block')}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="countries"
                    style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', display: 'block', marginBottom: 6 }}
                  >
                    {t('newTopicPage.isoCountryCodesLabel')}
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
                      background: 'var(--color-bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-control)',
                      padding: '10px var(--space-3)',
                      color: 'var(--foreground)',
                      fontSize: 'var(--text-body)',
                      outline: 'none',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.04em',
                      minHeight: 'var(--touch-target-min)',
                      boxSizing: 'border-box',
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
                              fontSize: 'var(--text-body)',
                              fontFamily: 'var(--font-mono)',
                              background:
                                code.length === 2
                                  ? 'color-mix(in srgb, var(--color-brand-accent) 10%, transparent)'
                                  : 'color-mix(in srgb, var(--color-status-danger) 10%, transparent)',
                              color: code.length === 2 ? 'var(--color-brand-accent)' : 'var(--color-status-danger)',
                              border: `1px solid ${code.length === 2 ? 'color-mix(in srgb, var(--color-brand-accent) 20%, transparent)' : 'color-mix(in srgb, var(--color-status-danger) 20%, transparent)'}`,
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
                    background: 'var(--color-bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-card)',
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
                      label={t('newTopicPage.scan.country')}
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
                    background: 'color-mix(in srgb, var(--color-brand-accent) 8%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-brand-accent) 25%, transparent)',
                    borderRadius: 'var(--radius-card)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <span style={{ color: 'var(--color-brand-accent)', fontSize: 18 }}>✓</span>
                    <span style={{ fontSize: 'var(--text-body)', color: 'var(--color-brand-accent)', fontWeight: 500 }}>{t('newTopicPage.verified.country')}</span>
                  </div>
                )}
              </div>
            )}

            {proofType === 'kyc' && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {!proofDone && (
                  <div style={{
                    padding: '16px',
                    background: 'var(--color-bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-card)',
                    textAlign: 'center',
                  }}>
                    <ProofGate
                      key={proofGateKey}
                      circuitType="coinbase_attestation"
                      scope="zkproofport-community"
                      mode="proof"
                      autoStart={false}
                      qrSize={200}
                      label={t('newTopicPage.scan.kyc')}
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
                    background: 'color-mix(in srgb, var(--color-brand-accent) 8%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-brand-accent) 25%, transparent)',
                    borderRadius: 'var(--radius-card)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <span style={{ color: 'var(--color-brand-accent)', fontSize: 18 }}>✓</span>
                    <span style={{ fontSize: 'var(--text-body)', color: 'var(--color-brand-accent)', fontWeight: 500 }}>{t('newTopicPage.verified.kyc')}</span>
                  </div>
                )}
              </div>
            )}

            {(proofType === 'workspace' || proofType === 'google_workspace' || proofType === 'microsoft_365') && (
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Provider selection (3 options) */}
                <div>
                  <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>
                    {t('newTopicPage.acceptedProviders')}
                  </p>
                  <div className="flex gap-3 flex-wrap">
                    {([
                      { value: 'google_workspace' as const, label: t('joinPage.providerGoogle') },
                      { value: 'microsoft_365' as const, label: t('joinPage.providerMicrosoft') },
                      { value: 'workspace' as const, label: t('newTopicPage.providerEither') },
                    ]).map((opt) => (
                      <label key={opt.value} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 14px',
                        background: proofType === opt.value ? 'color-mix(in srgb, var(--color-brand-primary) 6%, transparent)' : 'var(--color-bg-secondary)',
                        border: `1px solid ${proofType === opt.value ? 'color-mix(in srgb, var(--color-brand-primary) 30%, transparent)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-control)',
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                        fontSize: 'var(--text-body-sm)',
                        minHeight: 'var(--touch-target-min)',
                      }}>
                        <input
                          type="radio"
                          name="workspaceProvider"
                          checked={proofType === opt.value}
                          onChange={() => {
                            setProofType(opt.value);
                            setProofData(null);
                            setProofDone(false);
                            setProofGateKey((k) => k + 1);
                          }}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                  <p style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: '6px 0 0' }}>
                    {proofType === 'google_workspace'
                      ? t('newTopicPage.providerHint.googleOnly')
                      : proofType === 'microsoft_365'
                      ? t('newTopicPage.providerHint.microsoftOnly')
                      : proofType === 'workspace'
                      ? t('newTopicPage.providerHint.either')
                      : t('newTopicPage.providerHint.selectToContinue')}
                  </p>
                </div>

                {/* When "Either" is selected, creator must choose which provider to verify with */}
                {proofType === 'workspace' && (
                  <div>
                    <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>
                      {t('newTopicPage.verifyAffiliationWith')}
                    </p>
                    <div className="flex gap-3">
                      {([
                        { value: 'google' as const, label: t('joinPage.providerGoogle') },
                        { value: 'microsoft' as const, label: t('joinPage.providerMicrosoft') },
                      ]).map((opt) => (
                        <label key={opt.value} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 14px',
                          background: creatorProvider === opt.value ? 'color-mix(in srgb, var(--color-brand-accent) 6%, transparent)' : 'var(--color-bg-secondary)',
                          border: `1px solid ${creatorProvider === opt.value ? 'color-mix(in srgb, var(--color-brand-accent) 30%, transparent)' : 'var(--border)'}`,
                          borderRadius: 'var(--radius-control)',
                          cursor: 'pointer',
                          transition: 'all 0.12s',
                          fontSize: 'var(--text-body-sm)',
                          minHeight: 'var(--touch-target-min)',
                        }}>
                          <input
                            type="radio"
                            name="creatorProvider"
                            checked={creatorProvider === opt.value}
                            onChange={() => {
                              setCreatorProvider(opt.value);
                              setProofData(null);
                              setProofDone(false);
                              setProofGateKey((k) => k + 1);
                            }}
                            style={{ accentColor: 'var(--color-brand-accent)' }}
                          />
                          {opt.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Domain input (optional) */}
                <div>
                  <label
                    htmlFor="requiredDomain"
                    style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', display: 'block', marginBottom: 6 }}
                  >
                    {t('newTopicPage.domainRestrictionLabel')}{' '}
                    <span style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)' }}>{t('editTopicPage.optional')}</span>
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
                      background: 'var(--color-bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-control)',
                      padding: '10px var(--space-3)',
                      color: 'var(--foreground)',
                      fontSize: 'var(--text-body-sm)',
                      outline: 'none',
                      fontFamily: 'var(--font-mono)',
                      letterSpacing: '0.04em',
                      minHeight: 'var(--touch-target-min)',
                      boxSizing: 'border-box',
                    }}
                    onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--color-brand-primary)')}
                    onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                  />
                  <p style={{ fontSize: 'var(--text-caption)', color: 'var(--muted)', margin: '6px 0 0' }}>
                    {requiredDomain.trim()
                      ? t('newTopicPage.domainHint.restricted')
                      : t('newTopicPage.domainHint.open')}
                  </p>
                </div>

                {/* Workspace proof verification */}
                {!proofDone && (
                  <div style={{
                    padding: '16px',
                    background: 'var(--color-bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-card)',
                    textAlign: 'center',
                  }}>
                    {/* Show ProofGate only when provider is determined */}
                    {(proofType !== 'workspace' || creatorProvider) ? (
                      <ProofGate
                        key={`${proofGateKey}-${creatorProvider}`}
                        circuitType="oidc_domain_attestation"
                        scope="zkproofport-community"
                        domain={requiredDomain.trim() || undefined}
                        provider={proofType === 'microsoft_365' ? 'microsoft' : proofType === 'workspace' ? (creatorProvider ?? undefined) : 'google'}
                        mode="proof"
                        autoStart={false}
                        qrSize={200}
                        label={t('newTopicPage.scan.workspace', {
                          provider: proofType === 'microsoft_365' ? t('joinPage.providerMicrosoft')
                            : proofType === 'workspace' ? (creatorProvider === 'microsoft' ? t('joinPage.providerMicrosoft') : t('joinPage.providerGoogle'))
                            : t('joinPage.providerGoogle'),
                        })}
                        onProofData={({ proof, publicInputs, circuit }) => {
                          setProofData({ proof, publicInputs, circuit });
                          setProofDone(true);
                        }}
                      />
                    ) : (
                      <p style={{ fontSize: 'var(--text-body-sm)', color: 'var(--muted)', textAlign: 'center' }}>
                        {t('joinPage.selectProviderHint')}
                      </p>
                    )}
                  </div>
                )}
                {proofDone && (
                  <div style={{
                    padding: '12px 16px',
                    background: 'color-mix(in srgb, var(--color-brand-accent) 8%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-brand-accent) 25%, transparent)',
                    borderRadius: 'var(--radius-card)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}>
                    <span style={{ color: 'var(--color-brand-accent)', fontSize: 18 }}>✓</span>
                    <span style={{ fontSize: 'var(--text-body)', color: 'var(--color-brand-accent)', fontWeight: 500 }}>{t('newTopicPage.verified.organization')}</span>
                  </div>
                )}
              </div>
            )}

            {proofType !== 'none' && (
              <div style={{
                marginTop: 16,
                padding: 'var(--space-3) var(--space-4)',
                background: 'color-mix(in srgb, var(--color-brand-primary) 5%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-brand-primary) 15%, transparent)',
                borderRadius: 'var(--radius-control)',
                fontSize: 'var(--text-caption)',
                color: 'var(--muted)',
                lineHeight: 1.5,
              }}>
                <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>{t('joinPage.privacyLabel')}</span>{' '}
                {t('newTopicPage.privacyBody')}
              </div>
            )}
          </div>

          {error && (
            <p
              style={{
                fontSize: 'var(--text-body)',
                color: 'var(--color-status-danger)',
                margin: 0,
                fontFamily: 'var(--font-mono)',
                background: 'color-mix(in srgb, var(--color-status-danger) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-status-danger) 20%, transparent)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-2) var(--space-3)',
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
                padding: 'var(--space-3)',
                background: 'var(--border)',
                color: 'var(--muted)',
                textDecoration: 'none',
                borderRadius: 'var(--radius-control)',
                fontSize: 'var(--text-body-sm)',
                fontWeight: 500,
                minHeight: 'var(--touch-target-min)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {t('common.cancel')}
            </Link>
            <button
              type="submit"
              disabled={!canSubmit || imageUploading}
              style={{
                flex: 2,
                background: canSubmit && !imageUploading ? 'var(--accent)' : 'var(--border)',
                color: canSubmit && !imageUploading ? 'var(--color-text-inverted)' : 'var(--muted)',
                border: 'none',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-3)',
                fontSize: 'var(--text-body-sm)',
                fontWeight: 600,
                cursor: canSubmit && !imageUploading ? 'pointer' : 'not-allowed',
                transition: 'all 0.15s',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {imageUploading ? t('editTopicPage.uploadingImage') : loading ? t('newTopicPage.creating') : t('newTopicPage.createTopic')}
            </button>
          </div>
        </form>
      </div>
    </CommunityLayout>
  );
}
