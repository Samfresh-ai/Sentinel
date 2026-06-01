import type { Metadata } from "next";
import { Shell } from "./shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "OperaIQ",
  description: "Qdrant-powered autonomous incident response"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
