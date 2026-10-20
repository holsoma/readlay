import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { auth, authConfigured } from "@/auth";
import { books } from "@/data/books";
import { getBookContent } from "@/lib/book-content";
import Reader from "@/components/Reader";
import { AppShell } from "@/components/AppShell";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const book = books.find((item) => item.slug === slug);
  return book ? { title: `Read ${book.title}`, description: `Read ${book.title} by ${book.author} in your local Readlay library.`, robots: { index: false, follow: false } } : {};
}

export default async function BookReaderPage({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const book = books.find((item) => item.slug === slug);
  if (!book) notFound();
  const session = authConfigured ? await auth() : null;
  if (!session?.user?.id) redirect(`/sign-in?callbackUrl=${encodeURIComponent(`/read/${book.slug}`)}`);
  const content = await getBookContent(book.id);
  if (!content) return <AppShell title="Book unavailable"><section className="saved-heading"><h1>This reading file is unavailable.</h1><p>Import this edition on the computer running Readlay, then open the book again.</p><Link className="button secondary" href={`/book/${book.slug}`}>Back to book details</Link></section></AppShell>;
  return <Reader book={book} chapters={content.chapters} editionId={content.editionId} />;
}
