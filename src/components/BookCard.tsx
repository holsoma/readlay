"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, Bookmark } from "lucide-react";
import type { Book } from "@/data/books";
import { useReadlay } from "./ReadlayProvider";

export function BookCard({ book, index = 0 }: { book: Book; index?: number }) {
  const { savedIds, toggleSaved, notify, getProgress } = useReadlay();
  const saved = savedIds.includes(book.id);
  const progress = getProgress(book.id, book.editionId);

  return (
    <article className={`book-card book-colour-${index % 5}`}>
      <div className="book-display">
        <Link href={`/book/${book.slug}`} className="book-cover-link" aria-label={`View ${book.title}`}><Image src={book.cover} alt={book.coverAlt} width={600} height={900} className="book-cover" /></Link>
        <button className={`save-book icon-button ${saved ? "is-saved" : ""}`} aria-label={`${saved ? "Unsave" : "Save"} ${book.title}`} aria-pressed={saved} onClick={() => { toggleSaved(book.id); notify(saved ? "Book removed" : "Book saved"); }}><Bookmark size={17} fill={saved ? "currentColor" : "none"} /></button>
      </div>
      <div className="book-category">{book.categories[0]}</div>
      <h3><Link href={`/book/${book.slug}`}>{book.title}<ArrowUpRight size={16} aria-hidden="true" /></Link></h3>
      <p className="book-author">{book.author}</p>
      {book.isComplete === false && <p className="edition-note">Incomplete edition</p>}
      <Link className="book-status book-read-link" href={`/read/${book.slug}`} prefetch={false} aria-label={`${progress ? "Continue reading" : "Read"} ${book.title}`}><span />{progress ? "Continue reading" : "Read"}</Link>
    </article>
  );
}
