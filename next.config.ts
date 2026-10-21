import type { NextConfig } from "next";
import importedBooks from "./src/data/imported-books.json";

const audiobookMetadata = Object.entries(importedBooks).flatMap(([bookId, book]) =>
  ["manifest", "published"].map((name) => `.local/audiobooks/${bookId}/${book.editionId}/*/${name}.json`),
);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // These files are server-only. The reader and library API enforce sign-in.
  outputFileTracingIncludes: {
    "/read/*": [".local/books/*.json", ".local/reader/*.json"],
    "/api/book-assets/*": [".local/books/*.json", ".local/reader/*.json", ".local/book-assets/**/*"],
    "/api/library": [".local/books/*.json"],
    "/api/word-bank": [".local/books/*.json"],
    "/api/audio/*": [".local/books/*.json", ...audiobookMetadata],
  },
  // Automatic directory tracing must not package local preparation assets.
  outputFileTracingExcludes: {
    "/*": [
      ".local/tooling/**/*",
      ".local/audio-venv/**/*",
      ".local/audio-cache/**/*",
      ".local/audio-models/**/*",
      ".local/verification-runtime/**/*",
      ".local/*-qa/**/*",
      ".local/**/*.mp3",
      ".local/**/*.opus",
      ".local/**/*.epub",
      ".local/**/*.wav",
      ".local/audiobooks/**/preparation.json",
      ".local/audiobooks/**/upload-receipt.json",
      ".local/audiobooks/**/.upload-state.json",
      ".local/audiobooks/**/.cache/**/*",
      ".local/audiobooks/*/*/*/*/**",
      ".local/audiobooks/original-fixture/**/*",
    ],
  },
};

export default nextConfig;
