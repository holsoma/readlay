# Readlay

Read ebooks and switch to prepared audiobooks at your selected word.

**[Open Readlay](https://readlay.vercel.app)**

## Features

- Read on desktop or mobile, with adjustable text size and themes, source headings, quotations, lists and illustrations.
- Sign in with GitHub to synchronise reading progress, saved books and bookmarks.
- Look up a word with a tap, double-click or text selection, then save its definition and original context to your Word Bank.
- Check a second free dictionary when the first has no entry. For damaged EPUB spelling, look up a corrected word while retaining its original reading location.
- Search saved vocabulary, track New, Learning and Learned words, and return to their exact book locations.
- Use the persistent Listen from here control for a selected word, then return to the word being narrated. Looking up and saving words preserves your reading and audio positions.
- Choose a narrator and a playback speed from 0.75× to 2×.
- Prepare narration and word alignment locally with Kokoro and a free acoustic model. The website streams existing chapter Opus files without a speech API or GPU. Older paragraph MP3 recordings remain supported at their original precision.

Built with Next.js, TypeScript, Auth.js, Neon PostgreSQL and private Supabase Storage, with optional private Cloudflare R2 support. Audio preparation uses Python separately from the website.

Prepared recordings support Female (`af_heart`) and Male (`am_michael`) voice choices. Switching maps the current spoken word into the other recording, retaining playback speed and play/pause state. A voice is available only for chapters that have passed preparation and upload checks.

## Run locally

Use Node.js 22 or later. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev -- --hostname 127.0.0.1 --port 4401
```

Open [localhost:4401](http://localhost:4401). The catalogue works without credentials. Reading requires GitHub OAuth, a database and imported book text. Follow the [setup guide](docs/SETUP.md) to configure them.

Book text, generated audio, model files and credentials are excluded from this repository. Import editions you have permission to host before deploying your own reader.

Keep the original EPUBs. They contain the structure and images used by `scripts/prepare_reader.py` to create private reader presentation files. Reviewed display corrections repair damaged source tokens without changing the canonical offsets used by saved locations and narration. This is a checked repair layer, not a guarantee that every source OCR error has been removed. See the [setup guide](docs/SETUP.md) for preparation and deployment.

Seven Habits uses a reviewed complete PDF edition with all seven habits and 54 diagrams. Its local PDF importer preserves paragraph structure and extracts figures into the existing reader. Edition migration maps verified old words to the replacement, retains original account records and browser cache backups, and preserves matching bookmarks and Word Bank links. Python PDF tools are preparation dependencies only. The supplied DDIA draft is not part of the catalogue.

## Documentation

- [Setup and deployment](docs/SETUP.md)
- [Architecture and word synchronisation](docs/ARCHITECTURE.md)
- [Local Kokoro generation and audio upload](docs/AUDIO_PREPARATION.md)

`scripts/generate_audiobook_catalogue.py` prepares both voices in a resumable local batch. Its unpublished staging folder stays separate from the website's active audio. Before deployment, run `python scripts/pack_audio_metadata.py` after verified uploads. The website packages losslessly compressed timing manifests, while recordings, models and Python environments remain outside Vercel.

## Checks

```powershell
npm run lint
npm test
npm run build
python -m unittest discover -s scripts/audio/tests
python -m unittest scripts.test_prepare_reader scripts.test_import_books
python -m unittest scripts.test_import_pdf_book scripts.test_map_book_editions
```

## Licence

Readlay's application code and original cover studies use the [MIT licence](LICENSE). Font licences are included in `src/fonts`. Books, generated narration and third-party model assets have separate rights and are not covered by Readlay's licence.
## R2 usage protection

Readlay includes an administrator-only R2 usage page at `/admin/r2`, backed by the existing Supabase project. It checks storage and request budgets before uploads and audio requests, with default limits of 9 GB, 800,000 Class A and 8 million Class B operations. Configure the read-only Cloudflare Analytics token and admin GitHub IDs before enabling the release. Existing files are never deleted automatically. These checks cannot guarantee zero Cloudflare charges. See [setup and limitations](docs/R2_USAGE_PROTECTION.md).
