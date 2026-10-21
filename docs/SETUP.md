# Readlay setup

Read ebooks, bookmark passages and switch to prepared narration at your selected word. Built with Next.js, TypeScript and plain CSS. GitHub identifies each reader; Neon PostgreSQL stores saved books, bookmarks and edition-specific word progress. Kokoro and forced alignment run on the preparation computer only. The website never generates speech.

Run commands from the repository root.

## Run locally

Use Node.js 22 or later. Copy `.env.example` to `.env.local` and fill the required values without committing them.

```powershell
npm ci
npm run db:migrate
npm run dev -- --hostname 127.0.0.1 --port 4401
```

For a production preview, run `npm run build`, then `npm run start -- --hostname 127.0.0.1 --port 4401`. Stop an existing preview before rebuilding on Windows. Open [Readlay locally](http://localhost:4401).

The catalogue works without credentials. Book text and audio streams require a GitHub session. An unconfigured service displays an unavailable state; there is no simulated login or sample book.

## GitHub and progress storage

1. Register a [GitHub OAuth app](https://github.com/settings/developers). Set its homepage to the website origin and its callback to `<origin>/api/auth/callback/github`. For development use `http://localhost:4401/api/auth/callback/github`. Separate development and production OAuth apps avoid changing a live callback.
2. Set `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` and a random `AUTH_SECRET` of at least 32 characters. Use a different authentication secret for production.
3. Set `AUTH_URL` and `NEXT_PUBLIC_SITE_URL` to the actual deployment origin. Never put credentials in a variable beginning `NEXT_PUBLIC_`.
4. Set the pooled Neon connection as `DATABASE_URL`. Use `DATABASE_URL_UNPOOLED` for migrations.
5. Run `npm run db:migrate`. It applies numbered files in `db/migrations` in order within one transaction. Migration 001 creates the library tables; migration 002 adds the saved character offset without dropping existing data. Request handlers never change the schema.

For this linked workspace, `node --env-file-if-exists=.env.local scripts/configure-auth.mjs --check` checks the OAuth values without showing them. Omit `--check` to upload only those two values to `holsoma/readlay` through stdin. It does not download credentials or replace `AUTH_SECRET`. Redeploy after adding or changing the values.

The server derives storage ownership from the signed session. Browser caches and retry queues are separated by GitHub account. A cloud error leaves queued edits on the device and displays their unsynchronised status. Signing in loads the server state; guest saves are kept separate and are not silently merged.

## Import book text

Use Python 3.10 or later and place the eight supplied EPUBs in one directory:

```powershell
python scripts/import_books.py --source-dir "C:\path\to\epubs"
```

The importer writes private text to `.local/books` and aggregate statistics to `src/data/imported-books.json`. Edition identifiers change when the input or cleanup rules change. Audio and saved locations from another edition are rejected. Printed contents, copyright pages, advertisements, repeated running headings and empty sections are removed. Substantive introductions, notes and book content are preserved.

The reader presents text and omits images, diagrams and original layout. Reading estimates assume 250 words per minute. The supplied **The 7 Habits of Highly Effective People** file ends during Habit 4 and is labelled incomplete. Habits 5 to 7 cannot be recovered by cleaning that file.

The catalogue contains Atomic Habits, The 7 Habits of Highly Effective People, How to Win Friends and Influence People, The 48 Laws of Power, The Power of Your Subconscious Mind, Rich Dad Poor Dad, The 5 AM Club and The Power of Now. Four topics organise these books. The original sample has been removed.

## Prepare narration with Kokoro

See [audio preparation](AUDIO_PREPARATION.md) for installation, model download, generation, caches and upload commands, and [architecture](ARCHITECTURE.md) for the storage and synchronisation contract.

- Python, Kokoro, model weights and FFmpeg stay on the preparation computer.
- Generate sentence audio and align its waveform to the source words using a pinned local CTC acoustic model.
- Combine PCM audio into chapter files and encode each chapter once as Opus. Sample counts preserve offsets across sentences and paragraphs.
- A version 2 manifest maps source words to audio times and canonical EPUB CFIs. Unsupported or uncertain alignment stops publication. No paid speech or alignment API is used.
- Narrators have independent manifests and timings. The initial English voice is `af_heart`, which is not Singaporean English. Future providers can emit the same format.
- Upload completed Opus files and metadata to the existing **private** Supabase Storage bucket, allowing the `audio/ogg` MIME type. Deploy matching manifests only after upload. The server checks editions, source words, hashes, CFIs and paths before issuing expiring stream URLs.
- Playback speeds are 0.75, 1, 1.25, 1.5, 1.75 and 2 using the browser's `playbackRate`. Speed changes never regenerate audio.

Only prepared chapters are offered. Tap a word or select text to open the dictionary, then choose Set reading place or Listen from here. Playback begins at the explicitly selected word, and returning to Read marks and focuses the word currently being narrated. Dictionary lookup and saving alone do not change progress. The shared character offset survives device and mode changes. CFIs address the cleaned canonical EPUB exported by the preparation script, rather than the unmodified source archive. Legacy version 1 MP3 recordings remain available with paragraph precision clearly labelled.

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `AUDIO_STORAGE_BUCKET` on the server and preparation computer. Keep the bucket private and the service key out of the browser. `AUDIO_STORAGE_MODE=local` enables authenticated local audio preview; this option is ignored on Vercel.

Kokoro has no per-character API fee. Local generation uses the preparation computer's resources. Storage, bandwidth and hosting remain subject to service allowances and pricing. No Azure Speech package, key or variable is required.

## Dictionary and vocabulary

Dictionary lookup uses the required free [Dictionary API](https://dictionaryapi.dev/) first. If it fails or has no entry, the reader checks [FreeDictionaryAPI.com](https://freedictionaryapi.com/) for Wiktionary definitions and phonetics before trying a simpler inflection. A word is only cached as missing after both providers report no entry. Both are public CORS APIs with no key; the fallback currently allows 1,000 requests per hour per IP. Browser requests omit credentials and referrers, and validated results are cached. Each result shows its provider, original source and licence.

Recorded pronunciation uses the primary API's validated media URL. When none is available, the Device voice control uses an installed local English voice if the browser provides one. It never selects a remote speech service and needs no paid TTS API. Availability depends on the device's installed voices; missing pronunciation remains explicit. Missing definitions and service failures have retry controls. The compatibility `/api/dictionary` route and save requests without a displayed snapshot still require primary upstream server access, and can return a service error during provider outages or hosting-network restrictions.

The Word Bank uses the existing GitHub identity and Neon connection. The normal migration command now also runs `003_word_bank.sql`; no new database or authentication provider is required. The Vercel build applies it before serving the feature. The word-saving route needs the same private `.local/books/*.json` server files as the reader, included through `outputFileTracingIncludes` for `/api/word-bank`. These files must remain outside `public` and Git.

Open a word, choose Save to Word Bank, then use Word Bank in the sidebar, mobile navigation or reader toolbar. A repeat save at the same location is idempotent; saving the word elsewhere adds another original context. The Word Bank supports search, sorting, three learning states, removal and return links. Its saved occurrence highlights use edition-specific character ranges and remain stable after text size changes. Reimporting a changed edition does not apply old highlights to different text.

If a definition is missing, use the popup's corrected-spelling field. This also handles words damaged in the supplied EPUB, such as joined or incorrectly recognised letters. Known source errors can offer optional lookup suggestions, scoped to that edition. The reader never chooses a suggestion automatically or changes book text. Saving uses the corrected dictionary headword while retaining the original selected text, sentence and exact source location. The Word Bank displays the original spelling where it differs from the saved word. A clean replacement EPUB must be imported as a new edition with position migration considered separately.

## Deploy to Vercel

1. Import authorised books locally and prepare/upload the audio you intend to offer.
2. Link with `npx vercel link` and connect the project's Neon database in Vercel.
3. Add authentication, database and optional storage variables in Vercel. Set production URLs to the assigned domain and register the matching GitHub callback.
4. Run `npx vercel --prod` from this prepared directory. The build runs the migration using credentials already held in Vercel, then builds Next.js. A production database credential download is unnecessary.
5. Verify GitHub sign-in, a bookmark, progress from another browser and an uploaded audio chapter before describing the deployment as fully connected.

Private book JSON and audio manifests are included in the CLI deployment as server files. Opus files, MP3s, WAVs, canonical EPUBs, model weights, caches and Python environments are excluded. Audio streams from Supabase. Books and generated audio stay out of Git, so a Git-only deployment requires a separate private content delivery step. Never move them into `public`.

## Checks

```powershell
npm run lint
npm test
npm run build
python -m unittest discover -s scripts/audio/tests
```

The browser accessibility check uses `?__qa=1` and exposes JSON in `#readlay-qa`. Axe loads only when requested. Its local LCP/CLS readings are unthrottled; zero LCP means unavailable. Screenshot evidence and measured limits belong in `.jury`.

## Licences and content

Original application code and eight original typographic cover studies use the MIT licence. Font licences are in `src/fonts`. Imported book text, publisher artwork, generated narration and third-party model assets are excluded from the application's MIT licence. Kokoro's own licence does not grant rights to the books.

Prepare and distribute narration only for editions with the necessary permissions. Keep the preparation rights record. Signed-in access does not itself grant distribution rights.
