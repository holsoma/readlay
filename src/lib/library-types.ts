export type ReadingProgress = {
  chapterIndex: number;
  paragraphIndex: number;
  // UTF-16 offset in the cleaned paragraph. Missing offsets from older clients mean 0.
  charOffset?: number;
  cfi?: string;
};

export type SavedPassage = ReadingProgress & {
  id: string;
  bookId: string;
  editionId: string;
  chapterTitle: string;
  text: string;
};

export type LibraryState = {
  savedIds: string[];
  progressByEdition: Record<string, ReadingProgress>;
  bookmarks: SavedPassage[];
  lastReadBookId: string | null;
};

export type LibraryAction =
  | ({ type: "progress"; bookId: string; editionId: string } & ReadingProgress)
  | { type: "save-book"; bookId: string; saved: boolean }
  | ({ type: "bookmark"; bookId: string; editionId: string; saved: boolean } & ReadingProgress);

export type LibraryRequest = LibraryAction & {
  // A session-change guard only. The server obtains the storage identity from auth().
  expectedUserId: string;
};
