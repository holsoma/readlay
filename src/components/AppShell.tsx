"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Bookmark, BookA, ArrowUpRight, Info, Search } from "lucide-react";
import { useReadlay } from "./ReadlayProvider";
import type { ReactNode } from "react";
import { AccountButton } from "./AccountButton";
export function Brand() { return <Link href="/" className="brand" aria-label="Readlay home"><span className="brand-symbol" aria-hidden="true"><i /><i /></span><span>readlay<span className="brand-dot">.</span></span></Link>; }
export function AppShell({ children, title = "Your library", search }: { children: ReactNode; title?: string; search?: ReactNode }) {
  const pathname = usePathname(); const { savedIds } = useReadlay();
  return <div className="app-shell"><aside className="sidebar"><Brand /><div className="sidebar-section-label">Your reading space</div>
    <nav className="side-nav" aria-label="Main navigation"><Link href="/" className={pathname === "/" || pathname.startsWith("/book/") ? "active" : ""} aria-current={pathname === "/" ? "page" : undefined}><BookOpen size={19} /><span>Library</span></Link><Link href="/saved" className={pathname === "/saved" ? "active" : ""} aria-current={pathname === "/saved" ? "page" : undefined}><Bookmark size={19} /><span>Saved books</span>{savedIds.length > 0 && <span className="nav-count">{savedIds.length}</span>}</Link><Link href="/word-bank" className={pathname === "/word-bank" ? "active" : ""} aria-current={pathname === "/word-bank" ? "page" : undefined}><BookA size={19} /><span>Word Bank</span></Link></nav>
    <Link href="/about" className="sidebar-about"><Info size={17} /><span>About Readlay</span><ArrowUpRight size={15} /></Link></aside>
    <div className="workspace"><header className="topbar"><div className="mobile-brand"><Brand /></div><span className="page-location">{title}</span><div className="topbar-actions">{search || <Link className="header-search-link" href="/#catalogue" aria-label="Search the library"><Search size={19} /></Link>}<AccountButton /></div></header>
    <main id="main" className="main-content" tabIndex={-1} data-page>{children}</main><footer className="site-footer"><span className="footer-brand">readlay.</span><Link href="/about">About Readlay <ArrowUpRight size={13} /></Link></footer></div>
    <nav className="mobile-nav" aria-label="Mobile navigation"><Link href="/" aria-current={pathname === "/" ? "page" : undefined} className={pathname === "/" ? "active" : ""}><BookOpen size={19} />Library</Link><Link href="/saved" aria-current={pathname === "/saved" ? "page" : undefined} className={pathname === "/saved" ? "active" : ""}><Bookmark size={19} />Saved</Link><Link href="/word-bank" aria-current={pathname === "/word-bank" ? "page" : undefined} className={pathname === "/word-bank" ? "active" : ""}><BookA size={19} />Words</Link><AccountButton mobile /></nav></div>;
}
