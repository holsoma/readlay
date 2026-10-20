"use client";
import Link from "next/link";
import { Bookmark, ArrowRight, ArrowUpRight, X } from "lucide-react";
import { books } from "@/data/books";
import { useReadlay } from "./ReadlayProvider";
import { AppShell } from "./AppShell";
import { BookCard } from "./BookCard";
export function SavedBooks() {
  const { ready, savedIds, bookmarks, toggleBookmark, openAuth, isSignedIn, syncStatus } = useReadlay();
  const saved = books.filter((book) => savedIds.includes(book.id));
  const passages = bookmarks.flatMap((passage) => {
    const book = books.find((item) => item.id === passage.bookId);
    const editionId = book?.editionId;
    return book && editionId === passage.editionId ? [{ passage, book }] : [];
  });
  return <AppShell title="Saved books">
    <header className="saved-heading"><h1>Saved books</h1></header>
    <section className="saved-section" aria-labelledby="saved-books-title">
      <h2 id="saved-books-title">Books <span>{saved.length}</span></h2>
      {!ready ? <p className="saved-books-loading" role="status">Loading saved books…</p> : saved.length ? <div className="book-grid">{saved.map((book) => <BookCard key={book.id} book={book} index={books.findIndex((item) => item.id === book.id)} />)}</div> : <div className="empty-shelf"><Bookmark size={32} strokeWidth={1.3} /><h3>No saved books</h3><p>Save a book from the library.</p><Link className="button primary" href="/">Browse the library<ArrowRight size={17} /></Link></div>}
    </section>
    <section className="saved-section" aria-labelledby="saved-passages-title">
      <h2 id="saved-passages-title">Bookmarked passages <span>{passages.length}</span></h2>
      {!ready ? <p className="saved-bookmarks-loading" role="status">Loading bookmarks…</p> : passages.length ? <div className="passage-list">{passages.map(({ passage, book }) => {
        const readerPath = `/read/${book.slug}`;
        return <article className="saved-passage" key={passage.id}>
          <Bookmark size={20} />
          <div><p>{passage.text}</p><Link className="text-link" href={`${readerPath}?chapter=${passage.chapterIndex}&paragraph=${passage.paragraphIndex}`}>{book.title} · {passage.chapterTitle}<ArrowUpRight size={15} /></Link></div>
          <button className="icon-button" aria-label={`Remove bookmark from ${book.title}, chapter ${passage.chapterIndex + 1}, paragraph ${passage.paragraphIndex + 1}`} onClick={() => toggleBookmark(passage.chapterIndex, passage.paragraphIndex, passage.text, passage.bookId, passage.editionId, passage.chapterTitle)}><X size={17} /></button>
        </article>;
      })}</div> : <p className="empty-passages">Bookmark a paragraph while reading to find it here.</p>}
    </section>
    <div className="saved-sync"><p role="status">{!isSignedIn ? "Saved on this device." : syncStatus === "synced" ? "Your library is synced." : syncStatus === "syncing" ? "Synchronising your library…" : "Cloud sync is unavailable. Changes are kept on this device until it reconnects."}</p>{!isSignedIn && <button className="text-link" onClick={openAuth}>Sync across devices<ArrowUpRight size={15} /></button>}</div>
  </AppShell>;
}
