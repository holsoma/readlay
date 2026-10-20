# Readlay

Read ebooks and switch to prepared audiobooks at your selected word.

**[Open Readlay](https://readlay.vercel.app)**

## Features

- Read on desktop or mobile, with adjustable text size and themes.
- Sign in with GitHub to synchronise reading progress, saved books and bookmarks.
- Tap a word to listen from there, then return to the word being narrated.
- Choose a narrator and a playback speed from 0.75× to 2×.
- Prepare narration and word alignment locally with Kokoro and a free acoustic model. The website streams existing chapter Opus files without a speech API or GPU. Older paragraph MP3 recordings remain supported at their original precision.

Built with Next.js, TypeScript, Auth.js, Neon PostgreSQL and private Supabase Storage. Audio preparation uses Python separately from the website.

## Run locally

Use Node.js 22 or later. From the repository root:

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev -- --hostname 127.0.0.1 --port 4401
```

Open [localhost:4401](http://localhost:4401). The catalogue works without credentials. Reading requires GitHub OAuth, a database and imported book text. Follow the [setup guide](docs/SETUP.md) to configure them.

Book text, generated audio, model files and credentials are excluded from this repository. Import editions you have permission to host before deploying your own reader.

## Documentation

- [Setup and deployment](docs/SETUP.md)
- [Architecture and word synchronisation](docs/ARCHITECTURE.md)
- [Local Kokoro generation and audio upload](docs/AUDIO_PREPARATION.md)

## Checks

```powershell
npm run lint
npm test
npm run build
python -m unittest discover -s scripts/audio/tests
```

## Licence

Readlay's application code and original cover studies use the [MIT licence](LICENSE). Font licences are included in `src/fonts`. Books, generated narration and third-party model assets have separate rights and are not covered by Readlay's licence.
