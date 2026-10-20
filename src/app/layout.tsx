import type { Metadata } from "next";
import localFont from "next/font/local";
import { ReadlayProvider } from "@/components/ReadlayProvider";
import { WordBankProvider } from "@/components/WordBankProvider";
import { Motion } from "@/components/Motion";
import { QualityCheck } from "@/components/QualityCheck";
import { siteUrl } from "@/lib/site-url";
import "./globals.css";
import "./refinements.css";
import "./vocabulary.css";
const manrope = localFont({ src: "../fonts/manrope-200_800-normal.woff2", weight: "200 800", variable: "--font-manrope", display: "swap" });
const newsreader = localFont({ src: "../fonts/newsreader-200_800-normal.woff2", weight: "200 800", variable: "--font-newsreader", display: "swap" });
const description = "A little time, a good book. Readlay is a reading space for books about habits, people and the way we think. Explore the library and try the reader.";
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "Readlay | A little time, a good book", template: "%s | Readlay" }, description,
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: "Readlay", title: "Readlay | A little time, a good book", description, images: ["/opengraph-image"] },
  twitter: { card: "summary_large_image", title: "Readlay", description, images: ["/opengraph-image"] }, icons: { icon: "/icon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-GB" className={`${manrope.variable} ${newsreader.variable}`}><body>
    <a className="skip-link" href="#main">Skip to content</a><ReadlayProvider><WordBankProvider>{children}</WordBankProvider></ReadlayProvider>
    <div id="curtain" aria-hidden="true"><div className="curtain__panel" /></div><QualityCheck />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "WebApplication", name: "Readlay", applicationCategory: "EducationalApplication", operatingSystem: "Web", description }).replace(/</g, "\\u003c") }} /><Motion />
  </body></html>;
}
