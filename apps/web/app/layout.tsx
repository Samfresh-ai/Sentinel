import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "OperaIQ",
  description: "Autonomous SRE incident response"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen bg-background text-foreground">
          <header className="border-b border-border bg-background">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
              <Link href="/" className="font-mono text-xl font-semibold tracking-normal text-foreground">
                OperaIQ
              </Link>
              <nav className="flex items-center gap-4 text-sm text-muted">
                <Link href="/" className="hover:text-foreground">
                  Incidents
                </Link>
                <Link href="/brain" className="hover:text-foreground">
                  Brain
                </Link>
                <Link href="/services" className="hover:text-foreground">
                  Services
                </Link>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
