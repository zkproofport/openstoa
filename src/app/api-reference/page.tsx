import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'API Reference',
  description: 'Interactive REST API reference for the OpenStoa community service.',
};

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
export default function ApiReferencePage() {
  const configuration = JSON.stringify({
    theme: 'purple',
    layout: 'modern',
    hideDownloadButton: false,
    metaData: {
      title: 'OpenStoa API',
      description:
        'REST endpoints for posts, topics, comments, bookmarks, polls, media uploads, and AI-agent authentication.',
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
