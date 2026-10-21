"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Bookmark, BookOpen, Check } from "lucide-react";
import type { Book } from "@/data/books";
import { readingTime } from "@/lib/reading-time";
import { useReadlay } from "./ReadlayProvider";
import { AppShell } from "./AppShell";

export function BookDetail({ book }: { book: Book }) {
  const { savedIds, toggleSaved, notify, getProgress } = useReadlay();
  const saved = savedIds.includes(book.id);
  const progress = getProgress(book.id, book.editionId);

  return (
    <AppShell title="Book details">
      <Link className="back-link text-link" href="/"><ArrowLeft size={17} />Back to the library</Link>
      <article className="book-detail">
        <div className="detail-cover-stage"><Image className="detail-cover" src={book.cover} alt={book.coverAlt} width={600} height={900} priority /></div>
        <div className="detail-copy">
          <div className="detail-categories">{book.categories.map((category) => <span key={category}>{category}</span>)}</div>
          <h1>{book.title}</h1>
          <p className="detail-author">By {book.author}</p>
          <p className="detail-description">{book.description}</p>
          {book.isComplete === false && <p className="edition-warning"><strong>Incomplete edition.</strong> {book.availabilityNote}</p>}
          <dl className="detail-facts">
            <div><dt>Published</dt><dd>{book.year}</dd></div>
            <div><dt>Format</dt><dd>{book.format}</dd></div>
            <div><dt>Reading time</dt><dd>About {readingTime(book.readingMinutes)}</dd></div>
          </dl>
          <div className="detail-actions">
            <Link className="button primary" href={`/read/${book.slug}`} prefetch={false}><BookOpen size={18} />{progress ? "Continue reading" : "Read book"}<ArrowRight size={18} /></Link>
            <button className="button secondary" aria-pressed={saved} onClick={() => { toggleSaved(book.id); notify(saved ? "Book removed" : "Book saved"); }}>{saved ? <Check size={18} /> : <Bookmark size={18} />}{saved ? "Saved" : "Save book"}</button>
          </div>
          {!!book.illustrationCount && <p className="detail-format-note">{book.illustrationCount} diagrams and illustrations included.</p>}
        </div>
      </article>
    </AppShell>
  );
}
