import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Audio Journal | Recorder",
  description: "Grabacion web con transcripcion y resumen en audio",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
