<div align="center">

<a href="https://readlay.vercel.app">
  <img src="src/app/icon.svg" alt="Readlay logo" width="80" height="80" />
</a>

# Readlay

### Read. Listen. Keep your place.

Read ebooks, switch to prepared narration at a selected word, and save vocabulary as you go.

[![Web app](https://img.shields.io/badge/Open-Readlay-315B45?style=flat&labelColor=252D28)](https://readlay.vercel.app)
[![Licence: MIT](https://img.shields.io/badge/Licence-MIT-315B45?style=flat&labelColor=252D28)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-315B45?style=flat&labelColor=252D28)](docs/SETUP.md)

[Open Readlay](https://readlay.vercel.app) · [Features](#features) · [Setup guide](docs/SETUP.md) · [Contribute](CONTRIBUTING.md) · [Report an issue](https://github.com/holsoma/readlay/issues)

</div>

https://github.com/user-attachments/assets/72e47759-0a4c-454b-b4cc-e7df9bc86021

## Features

- **Read on desktop and mobile.** Adjust text size, switch between light, sepia and dark themes, and view the book's headings, quotations, lists and illustrations.
- **Listen from a word.** Select a word to start prepared narration there. Return to the reader at the word being spoken.
- **Choose how you listen.** Switch between available female and male narrators, with playback speeds from 0.75× to 2×.
- **Keep your place.** Sign in with GitHub to synchronise reading progress, saved books and bookmarks across devices.
- **Look up words as you read.** Tap, double-click or select a word to see its definition without changing your reading or listening position.
- **Build your Word Bank.** Save definitions with their original context, track New, Learning and Learned words, and return to where you found them.

Narration is available for prepared chapters and voices. Older paragraph-based recordings keep their original precision.

## Get started

**[Open Readlay in your browser](https://readlay.vercel.app)**. Browse the catalogue, then sign in with GitHub to read and save your place.

<details>
<summary><strong>Run locally</strong></summary>

Use Node.js 22 or later. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev -- --hostname 127.0.0.1 --port 4401
```

Open [localhost:4401](http://localhost:4401). The catalogue works without credentials. Reading requires GitHub OAuth, a database and imported book text. Follow the [setup guide](docs/SETUP.md) to configure these and run the database migrations.

Book text, generated recordings, model files and credentials are excluded from this repository. Import books you have permission to host.

</details>

## Documentation

| Guide | Contents |
| --- | --- |
| [Setup and deployment](docs/SETUP.md) | Authentication, storage, book imports, illustrations and edition changes. |
| [Architecture](docs/ARCHITECTURE.md) | Reading progress, bookmarks, vocabulary and word synchronisation. |
| [Audio preparation](docs/AUDIO_PREPARATION.md) | Local Kokoro narration, word timing, voice preparation and uploads. |
| [R2 usage protection](docs/R2_USAGE_PROTECTION.md) | Administrator setup, storage limits and request checks. These checks cannot guarantee zero charges. |
| [Promo video](readlay-promo/README.md) | Edit the Remotion scenes and render the README video. |
| [Contributing](CONTRIBUTING.md) | Development setup, tests, bug reports and pull requests. |

## Contributing

Read the [contribution guide](CONTRIBUTING.md) for development setup, checks and pull-request instructions. Use [GitHub issues](https://github.com/holsoma/readlay/issues) for bugs and feature requests. Keep credentials, private book text and generated recordings out of reports and pull requests.

<details>
<summary><strong>Development checks</strong></summary>

Run the checks relevant to your changes:

```powershell
npm run lint
npm test
npm run build
python -m unittest discover -s scripts/audio/tests
python -m unittest scripts.test_prepare_reader scripts.test_import_books
python -m unittest scripts.test_import_pdf_book scripts.test_map_book_editions
```

Reading, narration, bookmarks and Word Bank links share a saved location. Changes to book text or editions must preserve existing locations or use a reviewed edition migration. See the [architecture guide](docs/ARCHITECTURE.md).

</details>

### Built with

[Next.js](https://nextjs.org/) and [TypeScript](https://www.typescriptlang.org/) for the website, [Auth.js](https://authjs.dev/) for GitHub sign-in, and [Neon PostgreSQL](https://neon.com/) for saved progress. Prepared audio uses private [Supabase Storage](https://supabase.com/storage), with optional [Cloudflare R2](https://developers.cloudflare.com/r2/) support. Python prepares narration separately from the website.

### Credits

- [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for locally prepared narration.
- [Dictionary API](https://dictionaryapi.dev/) and [FreeDictionaryAPI.com](https://freedictionaryapi.com/) for word lookups.
- [Manrope](src/fonts/Manrope-OFL.txt) and [Newsreader](src/fonts/Newsreader-OFL.txt) for the typefaces.
- [Remotion](https://www.remotion.dev/) for the promo video.

### Licence

Readlay's application code and original cover artwork use the [MIT licence](LICENSE).

Books, generated narration and third-party models have separate rights. They are not covered by Readlay's licence. Font licences are included in [src/fonts](src/fonts).
