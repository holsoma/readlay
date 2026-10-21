# Local audiobook preparation

Readlay prepares audio on a local machine with Kokoro-82M. A separate acoustic model force-aligns the generated speech to the exact spoken transcript. FFmpeg combines cached sentence PCM into chapter Opus files. Private Supabase Storage holds the prepared audio and immutable timing manifests. Normal website operation needs no Python, GPU, model download or speech API.

The default female voice is `af_heart`; the catalogue batch also prepares the male voice `am_michael`. Both use American English. British voices such as `bf_emma` are separate narrator renditions. Kokoro does not provide a native Singaporean English voice. Each voice or future engine must produce alignment from its own recording.

## Install once

Use a separate Python 3.12 environment. In PowerShell from the repository root:

```powershell
uv venv --python 3.12 .local/audio-venv
uv pip install --python .local/audio-venv/Scripts/python.exe -r requirements-audio.txt
uv pip install --python .local/audio-venv/Scripts/python.exe https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
```

A registered Python installation can use `py -3.12 -m venv` and that environment's `python -m pip` instead. Install FFmpeg and ffprobe on `PATH`. FFmpeg must include `libopus`; maintaining old MP3 renditions also needs `libmp3lame`.

The pinned acoustic model is `facebook/wav2vec2-base-960h` at commit `22aad52d435eb6dbaf354bdad9b0da84ce7d6156`, licensed Apache-2.0. Its weights are about 378 MB. The initial setup also downloads Kokoro, the selected voice and language packages. Model assets default to `.local/audio-models`; `HF_HOME` can select another retained cache. On machines where Hugging Face Xet transfer stalls, set `HF_HUB_DISABLE_XET=1` before the initial download.

The normal generation command is offline. `--allow-download` permits a one-off model setup; it does not call an online narration service. Keep the packages and model cache to continue offline.

## Source and permission

Use the existing cleaned book JSON in `.local/books`:

```json
{
  "editionId": "exact-reader-edition-id",
  "chapters": [
    { "id": "chapter-1", "title": "First chapter", "paragraphs": ["First paragraph.", "Second paragraph."] }
  ]
}
```

The EPUB importer already produces this structure. Plain UTF-8 `.txt` input is also accepted, with blank lines separating paragraphs. It becomes one chapter; `--title` and `--edition-id` apply only to text input. PDF extraction is a separate preparation step. Review its order, headers and footnotes before supplying structured text.

Generate and distribute only editions with the necessary audio permissions. Record the existing permission with `--rights-confirmed`, or provide `--rights-file` containing:

```json
{ "bookId": "atomic-habits", "editionId": "the-exact-edition-id", "audioDistributionAllowed": true }
```

This records the operator's permission statement locally; it does not grant rights. The uploader requires a matching preparation record.

## Prepare and resume

A dry run needs no models, rights file, dependencies, network access or writes:

```powershell
python scripts/generate_audiobook.py .local/books/atomic-habits.json --book-id atomic-habits --chapters 1,2 --dry-run
```

Prepare an original fixture once with model downloads enabled:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook.py scripts/audio/tests/fixtures/original-book.json --book-id original-fixture --rights-confirmed --allow-download --bitrate 24k
```

Then prepare selected book sections offline:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook.py .local/books/atomic-habits.json --book-id atomic-habits --chapters 1,2 --rights-confirmed --bitrate 24k
```

Chapter selections are one-based, for example `1,3-5`. Stored indices are zero-based. Omit `--chapters` for a complete book only after checking narration, alignment and available storage. Run one preparation process per book and narrator at a time. CPU is the default; correctly configured machines can use `--device cuda` or `--device mps`.

Verified sentence WAVs are retained by exact source text, spoken normalisation, Kokoro model/voice hashes and provider versions. Sentence alignment is cached separately by audio SHA256 and every acoustic model and algorithm setting. Changing the aligner reuses existing narration. Model noise is seeded per text chunk. Corrupt caches are detected by hashes and structure checks. There is no expiry or automatic deletion.

Completed Opus chapters and exact word cues are verified and reused without narration, alignment or encoding. Matching partial runs merge coverage. Changed source text, voice, acoustic model, chunk settings, bitrate, paragraph gap or encoder creates a different generation path. Older generation files remain available. Do not discard these preparation directories if permanent reuse is required; a free remote storage plan is not a backup guarantee.

## Resumable catalogue batches

The local catalogue runner prepares every imported book with the female `af_heart` and male `am_michael` voices. It uses one retained provider for each voice and one acoustic aligner across the serial batch. It starts each selected book and voice before moving to the next chapter ordinal. Generation remains local and uses the existing sentence cache.

Inspect the complete plan without loading models or writing files:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook_catalogue.py --rights-confirmed --dry-run
```

Prepare or resume all books in `.local/books`:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook_catalogue.py --rights-confirmed --device cpu
```

Pass book IDs to prepare a selection, and `--device cuda` only on a configured CUDA machine. `--chapters` applies the same one-based chapter selection to every selected book:

```powershell
.local/audio-venv/Scripts/python.exe scripts/generate_audiobook_catalogue.py rich-dad-poor-dad subconscious-mind --chapters 1-2 --rights-confirmed
```

The operator must confirm audio preparation and distribution rights for every selected edition. `--voices` can replace the default voice pair. Models and voices must already be cached unless `--allow-download` is supplied for a one-off setup. The runner never uploads audio, changes a storage plan or deploys the website.

Output defaults to `.local/audiobook-batch-output`, separate from the website's active `.local/audiobooks` tree. A custom `--output-root` must also be unpublished staging storage. The runner rejects the active tree, its ancestors and descendants, and any staging tree containing a `published.json` receipt. Existing deployed manifests and publication receipts stay unchanged.

`batch-progress.json` is updated atomically before and after every chapter attempt. Private logs and error records are under `batch-logs/<bookId>/<editionId>/<voice>`. Error records include the exact source paragraph and sentence location when available. Keep the entire staging tree out of Git and website uploads. The console displays IDs, progress counts and file sizes without source text or exception contents.

A failed chapter does not prevent independent chapters or voices from being prepared. Press Ctrl+C to checkpoint an interruption. Run the same command to resume: the runner retries every selected chapter through the existing verification path, reusing verified Opus files, sentence recordings and acoustic alignments. It does not trust an old success flag as a substitute for checking files. Changes to source text or reviewed spoken corrections during a run stop preparation for that book until a new plan is started. Exit codes are `0` for all selected chapters ready, `1` for setup or chapter failures, and `130` for an interruption.

Review failed chapters and listen to the prepared speech before publication. Validate staged manifests with the existing uploader using `--output-root .local/audiobook-batch-output`; allow partial coverage only deliberately. After remote verification, copy only the matching base manifest and publication receipt to the active runtime tree. Batch generation itself never performs this activation.

## Sentence audio and genuine word alignment

1. Split source paragraphs at sentence boundaries. Adjacent very short complete sentences can share one chunk (a 40-character context target) within the same paragraph, so isolated hesitation words are not narrated or aligned without context. The maximum still applies. Overlong sentences split at whitespace within `--max-chars` (350 by default), retaining every original source offset. Unbroken words over the limit fail instead of being cut.
2. Build an explicit spoken English transcript. Numerals expand into words, grouped numbers, decimals, ordinals and currency amounts retain their meaning; explicit dictionary syllable middle dots are joined for speech while their original lexical ranges remain separate; supported Latin accents are transliterated, and contractions and hyphenated compounds retain their original source ranges. The exact same spoken text goes to Kokoro and the acoustic aligner. The reader text is unchanged. Unsupported words, ambiguous number formats and mathematical fractions fail instead of receiving invented timings. Write out the intended pronunciation in a reviewed source edition before retrying.
3. Generate mono signed 16-bit PCM at 24 kHz for each sentence. Cache it as WAV.
4. Resample each recording with a band-limited 24-to-16 kHz filter. The pinned Wav2Vec2 model calculates frame-level CTC log probabilities from the waveform.
5. Run a monotonic Viterbi CTC forced alignment over the full transcript, with explicit blank states and repeated-letter constraints. Every source word receives an acoustic interval. There is no proportional timing or paragraph-start fallback. Missing labels, invalid order or low-confidence alignment stop publication. Silent waveforms are rejected; every word must exceed 0.08 mean label confidence, and the sentence mean must exceed 0.20. Cached cues retain and re-check those confidence values.
6. Map every original lexical word to one cue using UTF-16 offsets, matching browser string offsets. A source token such as `42` has one cue covering its spoken expansion; `3.14` is also one source token covering its spoken decimal expansion. Word text is not copied into public manifests.
7. Concatenate sentence PCM once in source order and encode each chapter to Ogg Opus with FFmpeg `libopus`. The default is 24 kbit/s mono speech; 32 kbit/s and higher rates can be selected for a separate rendition. The optional paragraph pause (300 ms by default) belongs to the preceding paragraph interval. No pause is added between sentence chunks. FFmpeg bit-exact muxing settings make the same recording reproducible with the same encoder build.
8. Offset every sentence's word times by integer preceding PCM sample counts. ffprobe must report a chapter duration within 50 ms of that timeline before activation. The Opus pre-skip is handled by its container; player times follow the decoded media timeline.

These are acoustic estimates at the model's 20 ms frame stride, not a promise of zero-millisecond accuracy. Names, unusual numbers and abbreviations still need a listening check. Force alignment can fail on poor source text or speech. Review the source or pronunciation before retrying; do not replace a failure with estimated word timestamps. CTC confidence checks reject obvious bad paths but cannot prove pronunciation quality.

## Real EPUB CFI locations

Preparation creates a deterministic private `canonical.epub` from the exact cleaned reader text. It is a derivative EPUB, not the original supplied EPUB. Its package contains metadata, manifest and spine in that order. Every chapter XHTML has a head followed by a body containing only paragraph elements; every paragraph contains one original source text node.

A cue CFI is therefore literal:

```text
epubcfi(/6/<2*(chapterIndex+1)>[chapter-<chapterIndex+1>]!/4/<2*(paragraphIndex+1)>/1:<UTF16 charStart>)
```

The location scheme is `readlay-canonical-epub-v1`. Both the actual EPUB structure and the unchanged source text support those offsets. Never attach these CFIs to the original EPUB, whose wrappers, images and removed material differ. The canonical EPUB stays in private local preparation; no new public EPUB download is added.

## Files and manifest

```text
.local/audiobooks/<bookId>/<editionId>/<narratorId>/
  manifest.json
  published.json
  <generationId>/
    canonical.epub
    manifest.json
    preparation.json
    chapter-0001.opus
    chapter-0002.opus
    upload-receipt.json
.local/audio-cache/sentences/<prefix>/
  <audioCacheKey>.wav
  <audioCacheKey>.json
  <audioCacheKey>.<alignmentKey>.alignment.json
```

Schema v2 includes `alignment: "word"`, `format: "opus"`, `sampleRate: 24000`, narrator, source edition, coverage and canonical EPUB hash. Each chapter contains `byteLength`, audio SHA256, sample-derived paragraph segments, optional sentence cues, and `words` with `paragraphIndex`, `charStart`, `charEnd`, `startSeconds`, `endSeconds` and `cfi`. Publication requires exact coverage of every source lexical word, matching paragraph hashes, monotonic valid timestamps and canonical CFIs.

The website changes `HTMLMediaElement.playbackRate` for 0.75, 1, 1.25, 1.5, 1.75 and 2. No audio is regenerated. Reading to listening uses the selected source word's cue when Listen from here is chosen. Opening or saving a dictionary entry leaves the shared position unchanged. Listening to reading uses the current audio word cue and the same shared location. The browser cannot infer a silent reader's eye position; explicitly setting the current word or choosing Listen supplies that location.

Existing schema v1 paragraph-aligned MP3 uploads remain supported. Use `--legacy-paragraph-mp3` only when maintaining them. They remain labelled paragraph alignment and must never be described as exact word synchronisation.

## Private Supabase upload

Keep the existing private bucket. It must allow `audio/ogg` and `application/json`, plus `audio/mpeg` for legacy assets. Adding a MIME type must not make the bucket public. No Cloudflare account or paid speech service is required.

Provide process environment variables through the existing secret configuration:

```text
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only key>
AUDIO_STORAGE_BUCKET=readlay-audio
```

New `sb_secret_` keys are sent in the `apikey` header, never as JWT bearer tokens. Legacy service-role JWTs also use the bearer header. Neither key belongs in a client bundle or `NEXT_PUBLIC_` variable. The uploader reads its process environment and does not load `.env.local` itself. The existing `scripts/audio/configure_storage.mjs` helper validates and uploads only approved storage settings to the existing Vercel project without printing secret values.

Validate locally first:

```powershell
python scripts/upload_audiobook.py .local/audiobooks/atomic-habits/<editionId>/kokoro-af_heart/manifest.json --allow-partial --dry-run
```

Upload using the same path after credentials are present:

```powershell
python scripts/upload_audiobook.py .local/audiobooks/atomic-habits/<editionId>/kokoro-af_heart/manifest.json --allow-partial
```

`--allow-partial` explicitly acknowledges incomplete audio coverage; omit it for a complete book. `--create-bucket` creates a missing bucket as private. Existing public buckets are rejected.

Before upload, the command verifies preparation rights, generation paths, source hashes, actual canonical EPUB structure, word coverage, CFIs, byte lengths and audio hashes. Files up to 6 MiB use standard upload; larger files use resumable TUS with 6 MiB chunks. Existing objects are downloaded and SHA256 checked before reuse. Requests never enable overwrite. Every uploaded chapter and immutable hash-named manifest is downloaded and SHA256 checked before `published.json` activates the generation. Interrupted uploads retain completed objects and resumable state.

After upload verification, copy the complete verified narrator preparation into the active `.local/audiobooks` tree when a separate staging root was used. Run `python scripts/pack_audio_metadata.py` before building or deploying. This checks each publication hash and writes deterministic, lossless `manifest.json.gz` files. Only these compressed base manifests and their `published.json` receipts are traced into the website. Their publication hash still refers to the exact original uncompressed bytes. The loader rejects corrupt gzip and bounds decoded size to 64 MiB. Audio, canonical EPUBs, sentence caches, alignment models, Python environments and preparation records stay out of Next.js. Authenticated server routes authorise the reader and return short-lived private chapter URLs. Local preview mode is explicitly separate and unavailable on Vercel.

`--gzip-manifest` also stores a compressed remote timing manifest. This requires `application/gzip` in the private Supabase bucket's MIME allowlist. Upload receipts record both the original manifest hash and compressed object hash; every remote compressed object is read back and verified before activation. The local base manifest remains readable JSON for preparation and validation.

Local generation removes speech API costs. Supabase storage and transfer have finite free allowances. At a nominal 24 kbit/s, audio is roughly 10.8 MB per hour; 48 kbit/s is roughly 21.6 MB per hour. Opus variable bitrate, container overhead, pauses, metadata and additional narrators change the total. Supabase Free currently includes 1 GB of storage, shared with other stored assets. Estimate actual chapter bytes and full-book duration before a large upload, and stop when the free allowance is insufficient. The full catalogue is not guaranteed to fit. Do not enable a paid plan as an automatic fallback.

## Optional private R2 storage

The uploader also supports `--storage r2`. This is optional; existing Supabase publications remain valid. The publication receipt identifies the verified storage provider for each narrator, so preparing R2 credentials does not migrate or replace existing audio.

R2's included monthly usage is an allowance within a usage-billed service. It is not a guaranteed hard spending cap. Cloudflare requires an R2 subscription checkout, which may require a payment method, and charges for usage above the included allowance. Do not complete that checkout, attach billing information or switch this project to R2 without the account owner's agreement. A user requiring no attached billing information can retain Supabase while local audiobook preparation continues. Check [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and [account activation](https://developers.cloudflare.com/r2/get-started/) before choosing it.

After an approved private bucket and object-scoped S3 credentials exist, the separate helper can prepare local fields:

```powershell
node scripts/audio/configure_r2.mjs --initialise
```

Add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to ignored `.env.local`. The helper preserves existing credential lines and the existing `AUDIO_STORAGE_MODE`; a missing mode defaults to `supabase`. It never adds billing information, creates a subscription, changes bucket privacy or uploads audio. Validate without printing values or changing Vercel:

```powershell
node --env-file-if-exists=.env.local scripts/audio/configure_r2.mjs --check
```

Running the helper without a flag uploads only its five approved storage fields to the existing Readlay production and preview environments. Credentials travel through standard input, child-process output is discarded, and auth, database and Supabase credentials remain unchanged. Redeployment is separate. Leave `AUDIO_STORAGE_MODE=supabase` until an R2 default is explicitly wanted and configured; a verified R2 publication receipt can select R2 independently.

R2 bucket names must contain 3 to 63 lowercase letters, numbers or hyphens, starting and ending with a letter or number. Before upload, explicitly verify in Cloudflare that `r2.dev` access and public custom domains are disabled. S3 credentials cannot inspect those separate dashboard settings, so `--private-bucket-confirmed` records that operator check. The uploader uses `If-None-Match: *` and Standard storage, and reads each uploaded chapter and manifest back for SHA256 verification before writing a publication receipt. It rejects files above R2's 5 GiB single-request limit. The uploader never creates a bucket or enables public access.

R2 uploads now also require the existing server-only Supabase URL/key. Every GET, HEAD and PUT obtains an atomic quota reservation from Supabase before contacting R2. Configure and refresh the [R2 usage protection](R2_USAGE_PROTECTION.md) first. Missing usage, a stale inventory or an exhausted budget stops the upload, retains existing files and leaves publication receipts unchanged. Automatic S3 retries are disabled; a manual retry consumes another reservation. The production website does not issue new R2 signed playback URLs.

## Verification

```powershell
.local/audio-venv/Scripts/python.exe -m unittest discover -s scripts/audio/tests -p 'test_*.py' -v
node --test scripts/audio/tests/configure_storage.test.mjs
```

The Python suite retains legacy MP3 checks and adds Unicode UTF-16 ranges, apostrophes, hyphens, numerals, emoji, real canonical EPUB structure, unequal acoustic CTC peaks, repeated letters, sentence and alignment cache reuse, fail-closed missing words, real FFmpeg Opus generation, partial resume and upload validation. Controlled test alignments are test fixtures only. A real model smoke test and browser playback checks remain separate acceptance steps. Restricted Windows sandboxes can set `TMP` and `TEMP` to an ignored workspace folder.

The earlier deployed generation `07aa774d7336710f2a036e6d` is a legacy paragraph MP3 for Atomic Habits' opening section. It remains available at its immutable storage path. A v2 generation has a different generation ID and does not overwrite that recording.

## Verified preparation on 21 October 2026

The pinned acoustic model's 377,607,901-byte weight file matched its official SHA256 before use. Real offline Kokoro and CTC preparation then completed Atomic Habits' opening section and full introduction for source edition `f499e538de3e7e0a`. The active v2 generation is `80d7201c2f4fd2e734d43393`, using `af_heart` and 24 kbit/s mono Opus.

| Section | Paragraphs | Word cues | PCM duration | Encoded bytes | Minimum word confidence |
| --- | ---: | ---: | ---: | ---: | ---: |
| Opening | 7 | 42 | 22.425 s | 56,137 | 0.499792 |
| Introduction | 53 | 3,082 | 1,117.950 s | 3,149,617 | 0.304721 |
| Total | 60 | 3,124 | 1,140.375 s | 3,205,754 | |

The introduction includes long paragraphs and mid-paragraph source positions. Its mean word confidence was 0.978332. No confidence gate was weakened to produce these files. Context grouping resolved isolated hesitation utterances, and abbreviation handling kept author initials with their names. The source reader text and UTF-16 locations were unchanged.

The final preparation run reused retained sentence caches and took 71.813 seconds including model loading. An identical offline rerun took 12.172 seconds including model loading, with 0.2 seconds of chapter verification. It reused both completed chapters without narration, acoustic alignment or encoding. All sentence WAV, cached alignment and chapter Opus hashes and modification times remained unchanged. The local acceptance record is `.local/word-audio-acceptance.json`.

The opening Opus SHA256 is `3e2e0a164e417501a769ecf43934e7c2803f79a3d09a9a19f343b8b5bf16dc59`; the introduction hash is `27558ff19a79605735e981601ee17466a8bc3f61a11e230207f4cc2f43dae875`. Coverage remains explicitly incomplete at 2 of 28 sections. The remaining sections and other books were not generated in this acceptance run. These local checks prove preparation and cache reuse; publication and browser playback are separate deployment checks.

All 28 Python pipeline/upload tests passed, including real Opus encoding, legacy MP3 behaviour, model-independent CTC path checks, exact source/CFI validation, silence and uniform-emission rejection, cached-confidence checks and unchanged-output resume.

## Male and female playback verification on 21 October 2026

Both voices for Atomic Habits' opening and introduction passed local word alignment and immutable private Supabase upload checks. The male introduction contains 3,082 source-word cues and lasts 1,244.950 seconds. Its new GPU narration and alignment took 68.8 seconds after model loading. The male generation is `62d4d03174754a9fe349dad7`; this is separate from the existing female generation.

Live production checks confirmed that changing a paused recording maps source paragraph 38, UTF-16 range 87 to 94, to the same word in both voices. Playback at 1.5x continued through a playing voice change; paused playback stayed paused; the player retained one audio element. Test progress was restored to the account's original selected word and playback preferences were reset. This verification covers the prepared sections, not a claim that the full catalogue is complete.

## Primary references

- [Kokoro model and licence](https://huggingface.co/hexgrad/Kokoro-82M)
- [Official Kokoro Python package](https://github.com/hexgrad/kokoro)
- [Pinned English acoustic model, Apache-2.0](https://huggingface.co/facebook/wav2vec2-base-960h/tree/22aad52d435eb6dbaf354bdad9b0da84ce7d6156)
- [CTC forced alignment principles](https://docs.pytorch.org/audio/stable/tutorials/forced_alignment_tutorial.html). The deprecated TorchAudio helper APIs are not used.
- [EPUB CFI specification](https://w3c.github.io/epub-specs/epub33/epubcfi/index.html)
- [FFmpeg Opus encoder](https://ffmpeg.org/ffmpeg-codecs.html#libopus)
- [Supabase pricing and free storage allowance](https://supabase.com/pricing)
- [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
