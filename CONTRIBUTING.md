# Contributing to Readlay

Contributions can improve the reader, audio controls, Word Bank, accessibility, tests or documentation. For a larger feature or a change to saved locations, describe the problem in an [issue](https://github.com/holsoma/readlay/issues) before starting so the approach can be discussed.

## Report a bug or request a feature

Check the [existing issues](https://github.com/holsoma/readlay/issues) first. A useful bug report includes:

- The page or control involved, your browser and operating system.
- Steps that reproduce the problem, including whether you were signed in.
- What you expected and what happened instead.
- A screenshot or short recording when it helps explain the problem.
- Any relevant error message, with credentials and personal information removed.

For a feature request, explain the task you cannot complete and how the proposed behaviour would help. Use original sample text when demonstrating a reading or dictionary problem. Do not attach private books, narration files, account records or credentials.

## Set up a development copy

Use Git and Node.js 22 or later. Python is only needed for book preparation, narration and their tests. The audio tools recommend Python 3.12; see the [audio preparation guide](docs/AUDIO_PREPARATION.md) for its separate environment and FFmpeg requirements.

Fork the repository, clone your fork and create a branch for your change. From the repository root, run these PowerShell commands:

```powershell
git switch -c your-change
npm ci
Copy-Item .env.example .env.local
npm run dev -- --hostname 127.0.0.1 --port 4401
```

On macOS or Linux, use `cp .env.example .env.local` for the copy step. Open [localhost:4401](http://localhost:4401).

The catalogue works without credentials. To test reading, saved progress or audio, follow the [setup guide](docs/SETUP.md) to configure your own development GitHub OAuth app, database and private content. Use the callback `http://localhost:4401/api/auth/callback/github`. Set `.env.local` to your development services before running `npm run db:migrate`.

Private book text and generated narration are not included in the repository. Use editions you have permission to prepare and host. Keep source books, recordings, models and credentials in the ignored locations described in the setup guide.

## Find the relevant code

| Location | Purpose |
| --- | --- |
| `src/app/` | Pages, API routes and application styles. |
| `src/components/` | Reader, library, vocabulary and audio controls. |
| `src/lib/` | Saved locations, dictionary requests, audio timing and storage. |
| `db/migrations/` | Versioned changes to the library and Word Bank database. |
| `supabase/migrations/` | R2 usage accounting and request limits. |
| `scripts/` | Local book import, presentation and audio preparation. |
| `tests/` | JavaScript tests for application behaviour. |
| `docs/` | Setup, architecture and operational instructions. |
| `readlay-promo/` | Separate Remotion project for the README video. |

## Make the change

Keep a pull request focused on one problem. Follow the surrounding code and avoid unrelated formatting or dependency changes.

- **Read the installed Next.js guide.** This project uses a version with changed APIs. Follow `AGENTS.md` and the relevant files under `node_modules/next/dist/docs/` before changing application code.
- **Preserve saved locations.** Reading, listening, bookmarks and Word Bank links use a book edition and character offset. Offsets count UTF-16 code units. Do not rewrite canonical book text or reuse another edition's timings without a reviewed migration. The [architecture guide](docs/ARCHITECTURE.md) explains the shared location format.
- **Keep lookups separate from progress.** Opening the dictionary or saving a definition must not change the reader's current word or audio position.
- **Keep audio preparation local.** The website plays prepared recordings. Do not add speech generation, model downloads or Python to web requests. Offer only verified chapters and voices, and retain the stated precision of older recordings.
- **Keep private data private.** Check authentication and account ownership on server routes. Keep service keys on the server, storage buckets private, and secrets out of `NEXT_PUBLIC_` variables, logs and commits.
- **Check the interface.** Preserve keyboard access, visible focus, readable labels and reduced-motion behaviour. Check affected views at phone and desktop widths. Follow the existing colours, fonts and controls described in [PRODUCT.md](PRODUCT.md).
- **Write plainly.** Use UK English and direct wording. Do not use em dashes in new prose.

Add or update a regression test when fixing behaviour. Use small original fixtures and test the result a user depends on. For a documentation-only edit, check the affected instructions, links and Markdown rendering.

## Check your work

For application changes, run:

```powershell
npm run lint
npm test
npm run build
```

Run additional checks for the area you changed:

| Change | Check |
| --- | --- |
| EPUB import or reader presentation | `python -m unittest scripts.test_prepare_reader scripts.test_import_books` |
| PDF import or edition migration | `python -m unittest scripts.test_import_pdf_book scripts.test_map_book_editions` |
| Audio preparation or uploads | `python -m unittest discover -s scripts/audio/tests` |
| Promo video | Run `npm ci` and `npm run lint` inside `readlay-promo`, then preview or render the affected scenes. |
| Documentation | Check local links, code examples, media and the rendered Markdown. |

Install the preparation dependencies for the Python tests you run. PDF preparation uses `requirements-pdf-import.txt`; audio setup is documented in [AUDIO_PREPARATION.md](docs/AUDIO_PREPARATION.md).

The PostgreSQL integration tests use an optional local PGlite installation at `.local/verification-runtime/node_modules/@electric-sql/pglite`. They report skips when it is absent. State any skipped checks in your pull request. A passing test suite with skipped integration tests does not verify database behaviour.

For reading or listening changes, also check selecting a word, starting narration, returning to the current spoken word, switching available narrators, and restoring progress after a reload. For Word Bank changes, check that a saved word returns to its original passage.

## Open a pull request

Push your branch to your fork and open a pull request against `holsoma/readlay`'s `main` branch. Include:

1. The problem and the resulting behaviour. Link an issue if one exists.
2. The checks you ran, their results and anything you could not verify.
3. Screenshots or a short recording for interface changes, using original sample text.
4. Any new configuration, migration, preparation step or dependency needed to use the change.

Check the diff before submitting. Exclude `.env.local`, private content, generated audio, model files, build output and dependency folders. Update the relevant guide when a change affects setup or behaviour. Generated README media can be committed when the promo itself changes; follow the [video guide](readlay-promo/README.md).

Readlay's code and original cover artwork use the [MIT licence](LICENSE). Only contribute material you have the right to share, and retain third-party licence notices.
