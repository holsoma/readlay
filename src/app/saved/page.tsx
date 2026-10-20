import type { Metadata } from "next";
import { SavedBooks } from "@/components/SavedBooks";
export const metadata: Metadata = { title: "Saved books", description: "Your saved Readlay books and bookmarked passages, ready for your next reading session.", alternates: { canonical: "/saved" } };
export default function SavedPage() { return <SavedBooks />; }
