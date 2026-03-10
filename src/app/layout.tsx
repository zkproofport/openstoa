import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZK Community',
  description: 'Zero-knowledge proof gated community',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <main className="max-w-4xl mx-auto px-4">
          {children}
        </main>
      </body>
    </html>
  );
}
