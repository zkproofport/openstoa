import type { Metadata } from 'next';
import Script from 'next/script';
import { translate } from '@/lib/i18n';
import { getServerLocale } from '@/lib/i18n/getServerLocale';

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  return {
    title: translate(locale, 'metadata.apiReferenceTitle'),
    description: translate(locale, 'metadata.apiReferenceDescription'),
  };
}

/**
 * Interactive API reference rendered with Scalar's CDN bundle.
 *
 * We deliberately avoid pulling in a swagger-ui or @scalar/api-reference npm
 * dependency — the bundle is ~2 MB and the spec at `/api/docs/openapi.json`
 * is already complete. Loading the CDN script keeps the page slim and the
 * dependency surface unchanged.
 *
 * The companion `/docs` page covers the human-readable CLI quickstart;
 * this page is the machine-readable explorer (try-it-out, schemas, etc.)
 * for AI agents and integrators who want to poke individual endpoints.
 */
export default async function ApiReferencePage() {
  const locale = await getServerLocale();
  const configuration = JSON.stringify({
    theme: 'purple',
    layout: 'modern',
    hideDownloadButton: false,
    metaData: {
      title: 'OpenStoa API',
      description:
        translate(locale, 'metadata.apiReferenceEndpoints'),
    },
  });

  return (
    <main style={{ margin: 0, padding: 0, minHeight: '100vh' }}>
      <div
        id="api-reference"
        data-url="/api/docs/openapi.json"
        data-configuration={configuration}
      />
      <Script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference" strategy="afterInteractive" />
    </main>
  );
}
