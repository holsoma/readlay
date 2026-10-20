"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Bookmark, Search, SlidersHorizontal, X } from "lucide-react";
import { books } from "@/data/books";
import { AppShell } from "./AppShell";
import { BookCard } from "./BookCard";
import { useReadlay } from "./ReadlayProvider";

const categories = ["All books", "Habits", "People & influence", "Mind & awareness", "Money"];

export function Library() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All books");
  const [sort, setSort] = useState("curated");
  const { lastReadBookId, getProgress } = useReadlay();
  const filtered = useMemo(() => {
    const found = books.filter((book) =>
      (category === "All books" || book.categories.includes(category)) &&
      `${book.title} ${book.author} ${book.categories.join(" ")}`.toLowerCase().includes(query.toLowerCase().trim()),
    );
    return sort === "title"
      ? found.sort((a, b) => a.title.localeCompare(b.title))
      : sort === "year"
        ? found.sort((a, b) => (b.year || 0) - (a.year || 0))
        : found;
  }, [query, category, sort]);
  const recentBook = books.find((book) => book.id === lastReadBookId);
  const recentProgress = recentBook ? getProgress(recentBook.id, recentBook.editionId) : null;

  return (
    <AppShell search={
      <div className="search-box">
        <Search size={17} />
        <label className="sr-only" htmlFor="book-search">Search books or authors</label>
        <input id="book-search" type="search" placeholder="Search books or authors" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button className="icon-button" aria-label="Clear search" onClick={() => setQuery("")}><X size={15} /></button>}
      </div>
    }>
      <section className="library-hero" aria-labelledby="library-title">
        <div className="hero-copy"><h1 id="library-title">Good books.<br />Room to think.</h1></div>
        <div className="hero-art" aria-hidden="true">
          <div className="hero-orbit" />
          <div className="hero-book-back"><Image src={books[1].cover} alt="" width={600} height={900} priority /></div>
          <div className="hero-book-front"><Image src={books[0].cover} alt="" width={600} height={900} priority /><span className="hero-ribbon" /></div>
        </div>
      </section>
      {recentBook && recentProgress && (
        <Link href={`/read/${recentBook.slug}`} prefetch={false} className="sample-strip">
          <span className="sample-strip-icon"><Bookmark size={22} /></span>
          <div>
            <span className="sample-label">Continue reading</span>
            <h2>{recentBook.title}</h2>
            <p>Section {recentProgress.chapterIndex + 1} of {recentBook.chapterCount}</p>
          </div>
          <ArrowRight className="continue-arrow" size={21} aria-hidden="true" />
        </Link>
      )}
      <section id="catalogue" className="catalogue" aria-labelledby="catalogue-title">
        <div className="section-heading">
          <h2 id="catalogue-title">The bookshelf<span>{books.length}</span></h2>
          <label className="sort-control"><SlidersHorizontal size={15} /><span className="sr-only">Sort books</span>
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="curated">Curated order</option>
              <option value="title">Title A to Z</option>
              <option value="year">Newest first</option>
            </select>
          </label>
        </div>
        <div className="category-filters" aria-label="Filter books by topic">
          {categories.map((item) => <button key={item} className={category === item ? "selected" : ""} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}
        </div>
        <p className="sr-only" role="status">{filtered.length} {filtered.length === 1 ? "book" : "books"} shown</p>
        {filtered.length ? (
          <div className="book-grid">{filtered.map((book) => <BookCard key={book.id} book={book} index={books.findIndex((item) => item.id === book.id)} />)}</div>
        ) : (
          <div className="empty-results"><Search size={28} /><h3>No books found</h3><p>Try another title, author or topic.</p><button className="button secondary" onClick={() => { setQuery(""); setCategory("All books"); }}>Show all books</button></div>
        )}
      </section>
    </AppShell>
  );
}
