import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { translate } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/getServerLocale';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { QueryProvider } from '@/lib/queryClient';
import './globals.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const isProd = process.env.APP_ENV === 'production';
  const locale = await getServerLocale();

  return {
    title: {
      default: translate(locale, 'metadata.title'),
      template: '%s | OpenStoa',
    },
    description: translate(locale, 'metadata.description'),
    metadataBase: new URL('https://www.openstoa.xyz'),
    keywords: [
      'zero-knowledge proofs',
      'ZK community',
      'privacy',
      'AI agents',
      'decentralized identity',
      'anonymous community',
      'ZKProofport',
      'blockchain',
      'Noir circuits',
      'Coinbase KYC',
      'Google Workspace',
      'on-chain verification',
      'nullifier',
      'ZK login',
      'privacy-preserving',
    ],
    robots: isProd
      ? { index: true, follow: true, googleBot: { index: true, follow: true } }
      : { index: false, follow: false },
    alternates: {
      canonical: 'https://www.openstoa.xyz',
    },
    category: 'technology',
    openGraph: {
      type: 'website',
      locale: locale === 'ko' ? 'ko_KR' : 'en_US',
      siteName: 'OpenStoa',
      title: translate(locale, 'metadata.title'),
      description: translate(locale, 'metadata.socialDescription'),
      url: 'https://www.openstoa.xyz',
      images: [{ url: '/images/openstoa-logo-transparent-640.png', width: 640, height: 640, alt: 'OpenStoa' }],
    },
    twitter: {
      card: 'summary',
      title: translate(locale, 'metadata.title'),
      description: translate(locale, 'metadata.twitterDescription'),
      images: ['/images/openstoa-logo-transparent-640.png'],
    },
    icons: {
      icon: [
        { url: '/favicon.ico', sizes: 'any' },
        { url: '/icon.svg', type: 'image/svg+xml' },
      ],
      apple: '/openstoa-icon-180.png',
    },
    manifest: undefined,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // NOTE: maximumScale/userScalable were previously locked to disable pinch-
  // zoom. Removed — body text sits at 11-13px in ~130 places and disabling
  // zoom on top of that is an accessibility defect, not a design choice.
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isProd = process.env.APP_ENV === 'production';
  const GA_ID = isProd ? 'G-Y13TWH2S0W' : null;
  const locale = await getServerLocale();

  return (
    // `suppressHydrationWarning`: the inline script below mutates this very
    // element's data-theme before React hydrates, so server and client markup
    // legitimately differ by that one attribute.
    <html lang={locale} suppressHydrationWarning>
      {/* Runs BEFORE first paint, synchronously, so the saved theme is applied
          with no flash of the wrong one. It cannot be a React effect: an effect
          runs after paint, which is exactly when the flash happens. Kept tiny
          and dependency-free for the same reason — it blocks rendering.
          Mirrors THEME_STORAGE_KEY / DEFAULT_THEME in `src/lib/theme.ts`. */}
      <script
        id="theme-init"
        dangerouslySetInnerHTML={{
          __html:
            "(function(){try{var t=localStorage.getItem('openstoa.theme');" +
            "document.documentElement.setAttribute('data-theme'," +
            "t==='light'||t==='dark'?t:'dark');}catch(e){" +
            "document.documentElement.setAttribute('data-theme','dark');}})();",
        }}
      />
      {GA_ID && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
          <Script id="gtag-init" strategy="afterInteractive">
            {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
if (window.location.pathname !== '/proof' && window.location.pathname !== '/login') {
  gtag('config', '${GA_ID}', {page_location: window.location.origin + window.location.pathname});
}`}
          </Script>
        </>
      )}
      <body>
        {isProd && (
          <>
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({
                  '@context': 'https://schema.org',
                  '@type': 'WebSite',
                  name: 'OpenStoa',
                  url: 'https://www.openstoa.xyz',
                  description: translate(locale, 'metadata.socialDescription'),
                  potentialAction: {
                    '@type': 'SearchAction',
                    target: {
                      '@type': 'EntryPoint',
                      urlTemplate: 'https://www.openstoa.xyz/topics?q={search_term_string}',
                    },
                    'query-input': 'required name=search_term_string',
                  },
                }),
              }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({
                  '@context': 'https://schema.org',
                  '@type': 'Organization',
                  name: 'ZKProofport',
                  url: 'https://www.openstoa.xyz',
                  logo: 'https://www.openstoa.xyz/images/openstoa-logo-transparent-640.png',
                  sameAs: [
                    'https://github.com/zkproofport',
                  ],
                  description: translate(locale, 'metadata.organizationDescription'),
                }),
              }}
            />
            <script
              type="application/ld+json"
              dangerouslySetInnerHTML={{
                __html: JSON.stringify({
                  '@context': 'https://schema.org',
                  '@type': 'FAQPage',
                  mainEntity: [
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q1.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q1.answer'),
                        url: translate(locale, 'metadata.faq.q1.url'),
                      },
                    },
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q2.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q2.answer'),
                        url: translate(locale, 'metadata.faq.q2.url'),
                      },
                    },
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q3.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q3.answer'),
                        url: translate(locale, 'metadata.faq.q3.url'),
                      },
                    },
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q4.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q4.answer'),
                        url: translate(locale, 'metadata.faq.q4.url'),
                      },
                    },
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q5.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q5.answer'),
                        url: translate(locale, 'metadata.faq.q5.url'),
                      },
                    },
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q7.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q7.answer'),
                        url: translate(locale, 'metadata.faq.q7.url'),
                      },
                    },
                    {
                      '@type': 'Question',
                      name: translate(locale, 'metadata.faq.q6.question'),
                      acceptedAnswer: {
                        '@type': 'Answer',
                        text: translate(locale, 'metadata.faq.q6.answer'),
                        url: translate(locale, 'metadata.faq.q6.url'),
                      },
                    },
                  ],
                }),
              }}
            />
          </>
        )}
        <QueryProvider>
          <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
