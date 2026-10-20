import importedBooks from "./imported-books.json";

export interface Chapter {
  id: string;
  title: string;
  paragraphs: string[];
}

export interface Book {
  id: string;
  slug: string;
  title: string;
  author: string;
  year: number | null;
  categories: string[];
  description: string;
  cover: string;
  coverAlt: string;
  accent: string;
  placeholder: boolean;
  availability: "pending" | "available";
  format: "EPUB" | "Web reader";
  readingMinutes: number | null;
  audioAvailable: false;
  editionId?: string;
  wordCount?: number;
  chapterCount?: number;
  paragraphCount?: number;
  isComplete?: boolean;
  availabilityNote?: string;
}

interface ImportedBookStats {
  editionId: string;
  wordCount: number;
  readingMinutes: number;
  chapterCount: number;
  paragraphCount: number;
  isComplete?: boolean;
  availabilityNote?: string;
}

const importedStats = importedBooks as Record<string, ImportedBookStats>;

const catalogue: Book[] = [
  {
    id: "atomic-habits",
    slug: "atomic-habits",
    title: "Atomic Habits",
    author: "James Clear",
    year: 2018,
    categories: ["Habits"],
    description:
      "Small changes to daily routines can alter what we do over time. James Clear explains how to make useful habits easier to repeat and unwanted habits harder to maintain.",
    cover: "/covers/atomic-habits.svg",
    coverAlt: "Original Readlay concept cover for Atomic Habits",
    accent: "#254D3E",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "seven-habits",
    slug: "the-7-habits-of-highly-effective-people",
    title: "The 7 Habits of Highly Effective People",
    author: "Stephen R. Covey",
    year: 1989,
    categories: ["Habits"],
    description:
      "Seven principles for taking responsibility, choosing priorities and working with other people. Covey connects everyday decisions with the values behind them.",
    cover: "/covers/the-7-habits-of-highly-effective-people.svg",
    coverAlt: "Original Readlay concept cover for The 7 Habits of Highly Effective People",
    accent: "#D5B96C",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "win-friends",
    slug: "how-to-win-friends-and-influence-people",
    title: "How to Win Friends and Influence People",
    author: "Dale Carnegie",
    year: 1936,
    categories: ["People & influence"],
    description:
      "Practical advice on listening, showing appreciation and handling disagreement. Carnegie explores the small choices that shape our dealings with other people.",
    cover: "/covers/how-to-win-friends-and-influence-people.svg",
    coverAlt: "Original Readlay concept cover for How to Win Friends and Influence People",
    accent: "#CF7554",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "laws-of-power",
    slug: "the-48-laws-of-power",
    title: "The 48 Laws of Power",
    author: "Robert Greene",
    year: 1998,
    categories: ["People & influence"],
    description:
      "Historical examples of how people gain, protect and lose power, organised into forty-eight rules. Greene examines strategy, reputation and influence.",
    cover: "/covers/the-48-laws-of-power.svg",
    coverAlt: "Original Readlay concept cover for The 48 Laws of Power",
    accent: "#292D27",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "subconscious-mind",
    slug: "the-power-of-your-subconscious-mind",
    title: "The Power of Your Subconscious Mind",
    author: "Joseph Murphy",
    year: 1963,
    categories: ["Mind & awareness"],
    description:
      "Joseph Murphy argues that beliefs and repeated thoughts shape behaviour. He sets out exercises in visualisation and positive thinking, drawing on his spiritual outlook.",
    cover: "/covers/the-power-of-your-subconscious-mind.svg",
    coverAlt: "Original Readlay concept cover for The Power of Your Subconscious Mind",
    accent: "#A9B9A5",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "rich-dad-poor-dad",
    slug: "rich-dad-poor-dad",
    title: "Rich Dad Poor Dad",
    author: "Robert T. Kiyosaki",
    year: 1997,
    categories: ["Money"],
    description:
      "Kiyosaki contrasts two approaches to money through stories of his father and a friend's father. He argues for financial education and examines income, assets and ownership.",
    cover: "/covers/rich-dad-poor-dad.svg",
    coverAlt: "Original Readlay concept cover for Rich Dad Poor Dad",
    accent: "#E6DDCA",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "five-am-club",
    slug: "the-5-am-club",
    title: "The 5 AM Club",
    author: "Robin Sharma",
    year: 2018,
    categories: ["Habits"],
    description:
      "A story about using the early morning for exercise, reflection and learning. Sharma presents a routine for protecting attention and making time for personal goals.",
    cover: "/covers/the-5-am-club.svg",
    coverAlt: "Original Readlay concept cover for The 5 AM Club",
    accent: "#CF7554",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
  {
    id: "power-of-now",
    slug: "the-power-of-now",
    title: "The Power of Now",
    author: "Eckhart Tolle",
    year: 1997,
    categories: ["Mind & awareness"],
    description:
      "Eckhart Tolle examines the habit of dwelling on the past and anticipating the future. Through questions and answers, he offers a spiritual approach to paying attention to the present.",
    cover: "/covers/the-power-of-now.svg",
    coverAlt: "Original Readlay concept cover for The Power of Now",
    accent: "#CAD7D4",
    placeholder: true,
    availability: "pending",
    format: "EPUB",
    readingMinutes: null,
    audioAvailable: false,
  },
];

export const books: Book[] = catalogue.map((book) => {
  const stats = importedStats[book.id];

  return stats
    ? {
        ...book,
        availability: "available",
        editionId: stats.editionId,
        wordCount: stats.wordCount,
        readingMinutes: stats.readingMinutes,
        chapterCount: stats.chapterCount,
        paragraphCount: stats.paragraphCount,
        isComplete: stats.isComplete,
        availabilityNote: stats.availabilityNote,
      }
    : book;
});
