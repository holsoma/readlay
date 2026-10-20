import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "About Readlay",
  description: "Read eight books online, save passages and return to your place.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <AppShell title="About Readlay">
      <article className="about-page">
        <h1>A place to read.</h1>
        <p className="about-intro">Eight books about habits, people, the mind and money.</p>
        <section>
          <h2>Keep your place.</h2>
          <p>Choose a chapter, save a passage and return to the word you reached. Sign in with GitHub to keep your place across devices.</p>
        </section>
        <section>
          <h2>Text comes first.</h2>
          <p>Adjust the text size and page colour. Where word-aligned narration is available, tap a word to listen from there and return to the word being narrated. Images and diagrams are omitted.</p>
        </section>
        <section>
          <h2>Open code. Private books.</h2>
          <p>The application code and eight original covers use the MIT licence. Books and narration have separate permissions and are available to signed-in readers.</p>
        </section>
        <Link className="button primary" href="/">Open the library<ArrowRight size={18} /></Link>
      </article>
    </AppShell>
  );
}
