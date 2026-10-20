# Readlay setup

Read ebooks, bookmark passages and switch to prepared narration at your current paragraph. Built with Next.js, TypeScript and plain CSS. GitHub identifies each reader; Neon PostgreSQL stores saved books, bookmarks and edition-specific progress. Kokoro runs on the preparation computer only. The website never generates speech.

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
5. Run `npm run db:migrate`. It applies `db/migrations/001_library.sql` in one transaction, creating the three Readlay tables if absent. It does not drop data. Request handlers never change the schema.

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
- Generate paragraph audio, splitting long paragraphs internally while retaining one paragraph cue.
- Combine PCM audio into chapter files and encode each chapter once as MP3. Sample counts determine paragraph offsets before encoding.
- A versioned manifest maps paragraphs to time ranges and exact text hashes. No alignment model or paid speech API is used.
- Narrators have independent manifests and timings. The initial English voice is `af_heart`, which is not Singaporean English. Future providers can emit the same format.
- Upload completed MP3s and metadata to a **private** Supabase Storage bucket. Deploy the local manifests after upload. The server checks editions, paragraph hashes and paths before issuing expiring stream URLs.
- Playback speeds are 0.75, 1, 1.25, 1.5, 1.75 and 2 using the browser's `playbackRate`. Speed changes never regenerate audio.

Only prepared chapters are offered. “Listen from here” seeks to a paragraph's start. Returning to reading selects the paragraph containing the current audio time. Cross-device resume uses this paragraph and starts it from the beginning. Paragraph alignment does not claim word-level precision.

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `AUDIO_STORAGE_BUCKET` on the server and preparation computer. Keep the bucket private and the service key out of the browser. `AUDIO_STORAGE_MODE=local` enables authenticated local MP3 preview; this option is ignored on Vercel.

Kokoro has no per-character API fee. Local generation uses the preparation computer's resources. Storage, bandwidth and hosting remain subject to service allowances and pricing. No Azure Speech package, key or variable is required.

## Deploy to Vercel

1. Import authorised books locally and prepare/upload the audio you intend to offer.
2. Link with `npx vercel link` and connect the project's Neon database in Vercel.
3. Add authentication, database and optional storage variables in Vercel. Set production URLs to the assigned domain and register the matching GitHub callback.
4. Run `npx vercel --prod` from this prepared directory. The build runs the migration using credentials already held in Vercel, then builds Next.js. A production database credential download is unnecessary.
5. Verify GitHub sign-in, a bookmark, progress from another browser and an uploaded audio chapter before describing the deployment as fully connected.

Private book JSON and audio manifests are included in the CLI deployment as server files. MP3s, WAVs, model weights, caches and Python environments are excluded. MP3s stream from Supabase. Books and generated audio stay out of Git, so a Git-only deployment requires a separate private content delivery step. Never move them into `public`.

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
