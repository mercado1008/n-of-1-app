import type { Metadata } from "next";
import localFont from "next/font/local";
import "../src/app/globals.css";
import Link from "next/link";

const geistSans = localFont({
  src: "../src/app/fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "N of 1 Precision Formulation",
  description: "Clinical decision support for functional pathology formulation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} antialiased bg-cloud min-h-screen`}>
        <header className="bg-forest text-white">
          <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
            <div>
              <span className="font-semibold text-lg tracking-wide">N of 1</span>
              <span className="text-gold mx-2">·</span>
              <span className="text-sm text-sage">Precision Formulation</span>
            </div>
            <nav className="flex gap-6 text-sm">
              <Link href="/" className="text-sage hover:text-white transition-colors">
                New Submission
              </Link>
              <Link href="/submissions" className="text-sage hover:text-white transition-colors">
                History
              </Link>
            </nav>
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-6 py-8">
          {children}
        </main>
        <footer className="mt-16 border-t border-sage/30 py-4 text-center text-xs text-forest/50">
          Draft outputs pending practitioner review. The reviewing practitioner is the prescribing clinician of record.
        </footer>
      </body>
    </html>
  );
}
