import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { books } from "@/data/books";
import { BookDetail } from "@/components/BookDetail";
export const dynamicParams = false;
export function generateStaticParams() { return books.map((book) => ({ slug: book.slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> { const { slug } = await params; const book = books.find((item) => item.slug === slug); return book ? { title: book.title, description: book.description, alternates: { canonical: `/book/${slug}` } } : {}; }
export default async function BookPage({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; const book = books.find((item) => item.slug === slug); if (!book) notFound(); return <BookDetail book={book} />; }
