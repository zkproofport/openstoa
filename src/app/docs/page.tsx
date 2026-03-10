'use client';

import { useEffect } from 'react';

export default function DocsPage() {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/swagger-ui-dist/swagger-ui.css';
    document.head.appendChild(link);

    const style = document.createElement('style');
    style.textContent = `
      body { margin: 0; background: #1a1a2e; }
      .swagger-ui { filter: invert(88%) hue-rotate(180deg); }
      .swagger-ui .highlight-code,
      .swagger-ui .microlight { filter: invert(100%) hue-rotate(180deg); }
      .swagger-ui .topbar { display: none; }
    `;
    document.head.appendChild(style);

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js';
    script.onload = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.SwaggerUIBundle({
        url: '/api/docs/openapi.json',
        dom_id: '#swagger-ui',
        presets: [
          w.SwaggerUIBundle.presets.apis,
          w.SwaggerUIStandalonePreset,
        ],
        layout: 'BaseLayout',
        deepLinking: true,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
      });
    };
    document.head.appendChild(script);
  }, []);

  return (
    <div
      style={{ minHeight: '100vh', background: '#1a1a2e' }}
    >
      <div id="swagger-ui" />
    </div>
  );
}
