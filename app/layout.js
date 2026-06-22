import './globals.css';

export const metadata = {
  title: 'ChatRoom',
  description: 'Real-time chat rooms with invite codes, images and voice notes',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#111b21',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
