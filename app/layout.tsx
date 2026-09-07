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
        {/* First thing in the body, before anything paints: reading the stored choice in
            an effect would show a white page for a frame to everyone who chose dark. It
            lives here rather than between <html> and <body>, which is not valid HTML and
            which React rightly refuses to hydrate. Absent means "follow the OS". */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('o6-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
        {children}
      </body>
    </html>
  );
}

