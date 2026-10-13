export const metadata = { title: "fitscout", description: "A taste-trained resale scout for Meta Muse." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, background: "#faf9f7", color: "#1d1b18" }}>{children}</body>
    </html>
  );
}
