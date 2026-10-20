# Local audiobook preparation

Readlay prepares audio on a local machine with Kokoro, then uploads chapter MP3s to a private Supabase Storage bucket. The website reads prepared metadata and streams existing files. Its normal runtime has no Python, Kokoro, GPU or speech API dependency.

The default voice is `af_heart`, American English. A British voice can be prepared separately, for example `bf_emma`. These are existing Kokoro voices, not Singaporean English voices. Each narrator has separate audio and timing data. A future engine can implement the local `NarrationProvider` interface and emit the same manifest; its timings must be generated from its own audio.

## Install local tools once

Use Python 3.12. Kokoro 0.9.4 supports Python 3.10 to 3.13. Keep its packages separate from the website and the system Python installation.

PowerShell, from the repository root:

```powershell
py -3.12 -m venv .local/audio-venv
.local/audio-venv/Scripts/python.exe -m pip install -r requirements-audio.txt
.local/audio-venv/Scripts/python.exe -m spacy download en_core_web_sm
```

On a machine with `uv` instead of a registered Python installation:

```powershell
$env:UV_PYTHON_INSTALL_DIR = "$PWD/.local/tooling/python"
$env:UV_CACHE_DIR = "$PWD/.local/tooling/uv-cache"
uv python install 3.12
uv venv --python 3.12 .local/audio-venv
uv pip install --python .local/audio-venv/Scripts/python.exe -r requirements-audio.txt
uv pip install --python .local/audio-venv/Scripts/python.exe https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

Install `ffmpeg` and `ffprobe` and put both on `PATH`. Their build must include the `libmp3lame` encoder. Kokoro uses espeak-ng for English pronunciation fallback. Its current English dependencies include an espeak-ng loader; if that fails on your platform, install espeak-ng using its official platform instructions.

Dependencies and model weights need an initial download. After that setup, narration runs locally without contacting a speech API. Model files default to `.local/audio-models`; an existing `HF_HOME` environment variable takes precedence. Keep the language package, dependencies and model cache when preparing audio without a network connection.

## Input and permission record

Use the same structured book JSON as the reader:

```json
{
  "editionId": "edition-v1",
  "chapters": [
    { "id": "chapter-1", "title": "First chapter", "paragraphs": ["First paragraph.", "Second paragraph."] }
  ]
}
```

The existing EPUB importer creates this format in `.local/books`. PDF extraction is a separate preparation step: inspect its paragraph order, repeated page headers and footnotes before converting it to this format. The audio command does not attempt to parse PDFs.

UTF-8 `.txt` input is also accepted. Blank lines separate paragraphs, and the file becomes one chapter. Use `--title` and optionally `--edition-id`. Use structured reader JSON when preparing audio for the existing catalogue so paragraph indices and edition IDs match exactly.

Generate and distribute only editions for which you have the necessary audio rights. Record an existing permission with `--rights-confirmed`, or pass `--rights-file` containing:

```json
{
  "bookId": "atomic-habits",
  "editionId": "the-exact-imported-edition-id",
  "audioDistributionAllowed": true
}
```

The command records this locally in `preparation.json`. It does not verify or grant rights. The uploader refuses files without a matching permission record. Permission records and model caches are private preparation files, excluded from deployment.

## Inspect, prepare and resume

A dry run has no model dependencies, network access, audio generation or file writes:

```powershell
python scripts/generate_audiobook.py .local/books/atomic-habits.json --book-id atomic-habits --chapters 1 --dry-run
```

Start with the small original test text to download the chosen model and voice once:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook.py scripts/audio/tests/fixtures/original-book.json --book-id original-fixture --rights-confirmed --allow-download
```

Prepare a chapter from a supplied book using only the cached model:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook.py .local/books/atomic-habits.json --book-id atomic-habits --chapters 1 --rights-confirmed
```

Omit `--chapters` to prepare the full book. Selections such as `--chapters 1,3-5` use one-based chapter numbers. Stored indices use zero-based indices. Run one generation command per book and narrator at a time. CPU is the default; `--device cuda` or `--device mps` is optional on a correctly configured machine.

The default mode sets Hugging Face and Transformers to offline mode and requires cached assets. It checks for the English language package before constructing Kokoro, which prevents its automatic language-package download. `--allow-download` is explicit setup permission for the selected model and voice, not an online narration service.

Completed paragraph WAVs are cached by exact source-text hash, model and voice hashes, library versions, and chunk settings. Model noise is seeded from each text chunk so rebuilding a cache does not depend on chapter order. Re-running after interruption reuses verified caches. A failed paragraph or chapter is not added to the manifest. Complete chapter entries are saved after each successful encode. Matching partial runs merge coverage; changed source or render settings create a new generation. The encoder version is also included in that generation's settings.

Listen to the result before preparing a whole book. Short headings, uncommon names and text containing phonetic symbols can need editorial attention. The script never silently truncates a detected oversized phoneme sequence: lower `--max-chars` if it reports that error.

## Paragraph timings and MP3 encoding

1. Each original paragraph is narrated separately. Long paragraphs are split at sentence or word boundaries, with a hard limit for unbroken text. Those internal chunks retain a single paragraph cue.
2. Every model output becomes mono signed 16-bit PCM at 24,000 samples per second. Only a model chunk needs to fit in memory.
3. Paragraph PCM is cached as WAV. Chapter preparation streams those files into one ffmpeg encoder, in source order.
4. A deterministic 300 ms pause follows each paragraph except the final one. `--paragraph-gap-ms` can change this. The pause belongs to the preceding paragraph's interval, so there are no gaps in the synchronisation timeline.
5. Paragraph start and end positions come from integer PCM sample counts. Each chapter is encoded once to MP3, avoiding accumulated padding from concatenated paragraph MP3s. A Xing header supports seeking and gapless decoding.
6. ffprobe checks the chapter duration. A difference above 0.20 seconds between the PCM timeline and MP3 container duration stops publication. MP3 encoder delay is one chapter-level effect; browser seeking is still limited by MP3 decoding and the browser's seek precision.

Speech is prepared at its normal speed. The website changes its audio element's `playbackRate` to 0.75, 1, 1.25, 1.5, 1.75 or 2. Cue timestamps remain in the underlying recording's time, so no regenerated files are needed.

Paragraph intervals cover the whole chapter. Reading to listening seeks to the paragraph start. Listening to reading finds the interval containing the playback time. A pause between paragraphs returns the preceding paragraph; the exact boundary starts the next paragraph. Sentence or word cues can later be added as nested segment information without changing the source paragraph IDs.

## Files and manifest

```text
.local/audiobooks/<bookId>/<editionId>/<narratorId>/
  manifest.json
  published.json             # Only after matching files and metadata upload
  <generationId>/
    manifest.json
    preparation.json
    chapter-0001.mp3
    chapter-0002.mp3
    upload-receipt.json       # Only after every selected object uploads
```

The short generation ID derives from source text, actual model and voice hashes, preparation version and settings. A changed rendition uses a separate object path. The active local manifest is replaced atomically, while older generation files remain available for rollback.

The manifest contains:

- Book and edition IDs, narrator ID, display name, engine, voice and language.
- `schemaVersion: 1`, `alignment: "paragraph"`, `sampleRate: 24000` and `generationId`.
- `coverage: {complete, totalChapters, chapterIndices}`. Complete means every chapter present in the imported source is narrated. It does not certify that the source edition itself is complete. Partial runs keep their explicit chapter coverage.
- Original chapter indices, IDs and titles, MP3 object paths and durations.
- Paragraph indices, start/end seconds, exact integer `startSample`/`endSample`, and the SHA256 of each exact original UTF-8 paragraph.
- The SHA256 of each MP3 and its probed container duration.

The manifest does not contain paragraph text. Changes to imported text require a matching edition and new narration; never attach old timings to new text. The website validates hashes and chapter IDs before offering audio.

## Upload to private Supabase Storage

Set these variables in the local process through a secret manager or your normal local environment. Do not place their values in command history or commit them:

```text
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only sb_secret_ key or legacy service_role JWT>
AUDIO_STORAGE_BUCKET=readlay-audio
```

The variable `SUPABASE_SERVICE_ROLE_KEY` accepts either a new `sb_secret_` key or a legacy `service_role` JWT. The new secret key is preferred. Opaque `sb_secret_` keys go only in the `apikey` header; legacy JWTs also use `Authorization: Bearer`. New secret keys are not JWT bearer tokens. Both key types belong only in trusted local preparation and server environments, never in a browser bundle or a `NEXT_PUBLIC_` variable.

Initialise this workspace's approved Readlay project settings without showing or changing existing auth and database values:

```powershell
node scripts/audio/configure_storage.mjs --initialise
```

Add the server-only key from the approved project's Dashboard to the blank `SUPABASE_SERVICE_ROLE_KEY` field in ignored `.env.local`. The helper preserves an existing key. Check the four storage settings, then upload only those values to the existing `holsoma/readlay` Vercel project:

```powershell
node --env-file-if-exists=.env.local scripts/audio/configure_storage.mjs --check
node --env-file-if-exists=.env.local scripts/audio/configure_storage.mjs
```

The helper passes values to the Vercel CLI through stdin, removes app credentials from the child environment, and discards CLI output to prevent credential leakage. It uploads to production and preview without redeploying. The actual audiobook upload command below reads process environment variables directly and does not load `.env.local` automatically.

Validate files without reading credentials or contacting storage:

```powershell
python scripts/upload_audiobook.py .local/audiobooks/atomic-habits/<editionId>/kokoro-af_heart/manifest.json --allow-partial --dry-run
```

Upload a complete book:

```powershell
python scripts/upload_audiobook.py .local/audiobooks/atomic-habits/<editionId>/kokoro-af_heart/manifest.json --create-bucket
```

`--create-bucket` creates a missing bucket as private. An existing public bucket is rejected. A partial book requires the explicit `--allow-partial` flag. The command validates the generation record, source identity, object paths, chapter coverage and every local MP3 hash before making any request.

Files up to 6 MiB use a standard streaming upload. Larger files use Supabase's resumable TUS endpoint with 6 MiB chunks. Private upload state allows the same command to resume after interruption; expired sessions start again. No request enables overwriting. If an object already exists, the command streams and verifies its SHA256 before reusing it. A different object at the same path stops the upload. Bucket and account size limits still apply; a storage failure reports the HTTP status and leaves completed objects intact.

After every chapter in the manifest uploads, the command uploads the manifest itself under a name containing its SHA256. This keeps partial and complete metadata immutable even when chapter coverage grows. It then writes `upload-receipt.json` and a matching `published.json` beside the selected local manifest. The activation marker records the exact manifest hash, generation, storage origin, bucket and upload time. Failed uploads do not activate a new manifest.

Deploy the matching local `manifest.json` and `published.json` with Readlay only after that success. Supabase mode requires this marker to match. MP3s stay in storage; do not package them, WAV caches, model weights, Python environments or preparation records into the Next.js deployment. The website authorises GitHub users and issues short-lived URLs for the private chapter files. For a local preview, `AUDIO_STORAGE_MODE=local` may serve prepared files through authenticated local routes without an upload marker. That mode is not used on Vercel.

Storage and transfer quotas are separate from narration. Local Kokoro removes speech API charges; storage and bandwidth can exceed a provider's free allowance as usage grows.

## Tests

```powershell
python -m unittest discover -s scripts/audio/tests -v
node --test scripts/audio/tests/configure_storage.test.mjs
```

Tests use original fixture text and a deterministic test provider, without model dependencies or network requests. They exercise real MP3 encoding when ffmpeg and ffprobe are installed, exact sample offsets, paragraph gaps, cache recovery, rights records, partial coverage, immutable paths and upload safety checks. They do not prove narration quality. Keep the small Kokoro fixture smoke test and a listening check as separate setup checks.

On a restricted Windows environment whose default temporary folder is not writable, set `TMP` and `TEMP` to an ignored workspace folder before running the tests.

### Verified setup on 21 October 2026

The isolated workspace environment used Python 3.12.13, Kokoro 0.9.4, Misaki 0.9.4, PyTorch 2.14.1, spaCy 3.8.16 and `en_core_web_sm` 3.8.0, with the `af_heart` voice and CPU inference. The 17 dependency-free pipeline and upload tests passed, including real ffmpeg chapter encoding and both API-key header formats. The six Node storage-configuration tests also passed, including whitespace-formatted key assignments and secret-safe Vercel upload behaviour.

The original fixture was narrated with a one-off model download enabled. Its two MP3 chapters were 10.75 seconds and 4.85 seconds, with three paragraph cues and 126,234 bytes of audio in total. Preparation took 5.9 seconds after model loading.

After the text cleanup stabilised at parser `readlay-text-v4`, Atomic Habits chapter 1 was prepared again using default offline settings and the cached model. The current source edition is `f499e538de3e7e0a`, with 28 sections, 2,331 paragraphs and 77,553 words. The chapter MP3 is 24.275 seconds and 194,925 bytes, with all seven source paragraphs mapped to consecutive audio intervals. Preparation took 1.0 second after model loading, reusing the verified paragraph caches. Its manifest records `complete: false`, `totalChapters: 28` and `chapterIndices: [0]`. The remaining chapters were not generated.

The current manifest is `.local/audiobooks/atomic-habits/f499e538de3e7e0a/kokoro-af_heart/manifest.json`, with generation ID `07aa774d7336710f2a036e6d`. Verification checked all seven exact source-text SHA256 hashes, the chapter ID, consecutive integer sample offsets, second values derived from those offsets, the final chapter duration and the MP3 SHA256. The encoded duration also measured 24.275 seconds.

Both manifests passed the uploader's local dry-run validation. The original fixture remains local and is not a catalogue book.

The approved Supabase project `readlay` was created in organisation `holsoma`, in Singapore (`ap-southeast-1`), after the provider quoted $0 per month. Its project reference is `tgxmdccqlbyevpjhthxv`. The private `readlay-audio` bucket contains only the current Atomic Habits chapter 1 MP3 and its immutable manifest. Both remote files were downloaded through authenticated requests and their SHA256 hashes matched the local preparation files. The new server-only `sb_secret_` key worked using the `apikey` header without a bearer token.

The matching local `published.json` activation marker was written and verified. Its manifest hash is `65b2aeca60ae0bd7625228641fdff982ef4d9de93097101cc81bf48b3c88f138`; the MP3 hash is `0c8cc9c033f1eda6d14d2e3ab0f3915f5a8897ac5db1e0b8ba8f4fbdb19d4324`. The remaining 27 chapters were not generated or uploaded. The four storage environment values were securely uploaded to the existing `holsoma/readlay` Vercel production and preview environments. Metadata checks confirmed all four variable names in both environments without retrieving values. Auth and database variables were unchanged, and this setup did not redeploy the website. A non-secret setup and cost record is stored in ignored `.local/audio-setup.json`. These storage checks do not prove browser playback.

## Primary references

- [Official Kokoro repository and Python usage](https://github.com/hexgrad/kokoro)
- [Kokoro model and licence](https://huggingface.co/hexgrad/Kokoro-82M)
- [Official voice catalogue](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
- [Supabase standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
- [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
