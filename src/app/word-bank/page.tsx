import type { Metadata } from "next";
import { WordBank } from "@/components/WordBank";

export const metadata: Metadata = {
  title: "Word Bank",
  description: "Your saved vocabulary, definitions and the passages where you found each word.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/word-bank" },
};

export default function WordBankPage() { return <WordBank />; }
