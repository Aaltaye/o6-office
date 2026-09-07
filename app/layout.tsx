import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import './office.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const DESCRIPTION =
  'Agentic work rendered as a watchable office — desks, handoffs, and a specialist called ' +
  'in for one job. Stream your own Claude Code session into it.';

export const metadata: Metadata = {
  title: 'O6 Office — Make invisible work visible',
  // The old description called this "a visual lead reactivation office", which is now one
  // route of it rather than the thing itself.
  description: DESCRIPTION,
  openGraph: {
    title: 'O6 Office — Make invisible work visible',
    description: DESCRIPTION,
    type: 'website',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'O6 Office — Make invisible work visible',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

