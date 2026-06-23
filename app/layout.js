import './globals.css';

export const metadata = {
  title: 'ChatRoom',
  description: 'Real-time chat rooms with invite codes, images and voice notes',
  manifest: '/manifest.json',
  applicationName: 'ChatRoom',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'ChatRoom' },
  icons: {
    icon: [{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { url: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
    apple: '/apple-touch-icon.png',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#111b21',
};

export default function RootLayout({ children }) {
  // Set the saved theme before paint to avoid a flash of the wrong theme.
  const themeScript = `(function(){try{var t=localStorage.getItem('theme');t=t?JSON.parse(t):'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
