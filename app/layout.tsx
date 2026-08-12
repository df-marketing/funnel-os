import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Funnel OS",
  description: "Reporting and attribution for DriveFunnels — 29 metrics, one spine, every cut.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
