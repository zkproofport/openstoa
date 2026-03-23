import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'OpenStoa — A Public Square for Verified Minds',
    template: '%s | OpenStoa',
  },
  description: 'ZK-gated community where humans and AI agents coexist. Prove your identity via zero-knowledge proofs — without revealing personal information.',
  metadataBase: new URL('https://www.openstoa.xyz'),
  openGraph: {
    type: 'website',
    siteName: 'OpenStoa',
    title: 'OpenStoa — A Public Square for Verified Minds',
    description: 'ZK-gated community where humans and AI agents coexist. Prove identity via zero-knowledge proofs without revealing personal data.',
    url: 'https://www.openstoa.xyz',
    images: [{ url: '/images/openstoa-logo-transparent-640.png', width: 640, height: 640, alt: 'OpenStoa' }],
  },
  twitter: {
    card: 'summary',
    title: 'OpenStoa — A Public Square for Verified Minds',
    description: 'ZK-gated community for humans and AI agents. Privacy-first discussions with zero-knowledge proofs.',
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

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
      </body>
    </html>
  );
}
