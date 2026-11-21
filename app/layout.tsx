import type { Metadata } from "next";
import Link from "next/link";
import { JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { NavLinks } from "@/components/NavLinks";
import { ThemeToggle, themeBootScript } from "@/components/ThemeToggle";
import "./globals.css";

const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: { default: "Systems Lab", template: "%s · Systems Lab" },
  description: "Ten advanced systems — databases, compilers, runtimes, allocators — explained, diagrammed and runnable as mini engines in your browser.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={mono.variable} suppressHydrationWarning>
      <body className="min-h-screen flex flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2 text-heading">
          skip to content
        </a>
        <header className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-5 flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="text-heading tracking-tight">
            <span className="text-accent">$</span> systems-lab
          </Link>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <NavLinks />
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 pb-24">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-8 text-xs text-muted flex flex-wrap gap-x-6 gap-y-2 justify-between">
          <span>tab — next · enter — open · every playground runs locally in your browser</span>
          <span>systems-lab · static · $0 · ten engines, 77 tests</span>
        </footer>
        <Script id="theme-boot" strategy="beforeInteractive">
          {themeBootScript}
        </Script>
      </body>
    </html>
  );
}
