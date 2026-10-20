# Readlay design mock-up

## Brief
Build a responsive reading product for books about habits, people, the mind and money. Eight imported books use four topics and original typographic covers. The sample and redundant marketing copy have been removed. Auth.js handles GitHub sign-in; Neon stores account progress and bookmarks. The reader now includes playback of locally prepared Kokoro narration and paragraph-level reading/listening switching. Service credentials and uploaded recordings determine what can be used in a deployment. See README.md and docs/ARCHITECTURE.md for setup and current limits.

Imported text lives in the Git-ignored `.local/books` directory. Only edition identifiers and aggregate reading statistics enter `src/data/imported-books.json`. The reader omits EPUB images, diagrams and original page layout. Reading estimates use 250 words per minute. Original application code and covers use MIT; imported books and generated narration do not. Audio is generated outside Next.js as paragraph PCM chunks, combined into chapter MP3s and streamed from private Supabase Storage. There is no real-time speech API.

## Concepts considered
| Territory | Idea and anchor | Signature and screenshot | Emotion | Originality / fit / feasibility / portability |
| --- | --- | --- | --- | --- |
| Name | The place you left. Readlay relays one marked position from the library into the text. | A green bookmark travels from the book spine into the reader margin. Library shelf with an open invitation to read. | Settled, ready to begin | 4 / 5 / 5 / 2 |
| Material | The reading desk. A library laid out like books waiting on a desk. | Covers lift from coloured paper fields. An asymmetric book display. | Tactile and unhurried | 3 / 4 / 5 / 4 |
| Formal | One thought at a time. All navigation follows a single vertical line. | An index contracts into one narrow column of prose. | Concentration | 4 / 4 / 4 / 3 |

Pick the place you left: the bookmark is the product's central object and survives every page type, including an empty shelf and a lost-page state.

## Concept card
Idea: A library that keeps a clear place for your next reading session.
Metaphor: A physical bookmark carried between shelf and page.
Signature: Covers lift from the shelf on focus or hover; the recurring bookmark becomes a selected-paragraph marker in the reader. Page content settles into place without delaying navigation.
Emotion: Recognisable as a useful personal library in the first three seconds.
Motion verb: Lift and settle.
Screenshot: Large literary heading opposite a green book composition, followed by eight varied covers across a responsive shelf.

## System
- Ground #F7F8F5, ink #252D28, muted #647067, line #DDE2DA, accent #315B45, soft field #E8EEE5. Cover colours belong to the individual books.
- Manrope variable for navigation, metadata and controls; Newsreader variable for display and reading. Self-hosted Google Fonts, under the respective open font licences.
- Desktop: 216px library rail; fluid main column with a 1440px maximum; 12-column logic with 32px internal gaps. Mobile: compact header, Library and Saved tabs, native content scroll and a two-column book shelf. Fixed bottom navigation was removed after visual review because it covered content.
- Radius 12px for surfaces, 6px for small controls, pill for category toggles. Book edges remain almost square.
- GSAP power3 easing family. 180ms feedback, 320ms page entry, 420ms larger bookmark move. No loader, no WebGL, no scroll pinning. Lenis only on fine-pointer catalogue views; native scroll in the reader and under reduced motion.
- Still at rest is a deliberate decision: this is a reading tool. A moving decorative object would distract from choosing or reading a book. Primary links and covers lift or draw an underline, controls have press and focus states.

## Composition
Library header: [location]                 [search] [GitHub sign-in]
Hero:           [large literary heading]   [book and bookmark composition]
Continue:       [bookmark] [book + saved place or sample context] [open reader]
Shelf:          [heading + count]                       [sort]
Filters:        [All books] [Habits] [Productivity] [Personal development] ...
Books:          [cover] [cover] [cover] [cover] [cover]
Footer:         [Readlay purpose]                 [preview / artwork credit]
Detail:         [large cover] [category, title, author, description, availability]
Reader:         [library link] [title] [contents / type / theme / bookmark]
                [chapter margin] [centred prose] [saved position marker]
Saved:          [heading] [saved books or designed empty shelf] [saved passages]
404:            [empty bookmark] [page not found] [back to library]

## Genericness review
Removed the marketing feature-card grid, sign-up hero and audio waveform. Replaced generic book stock photography with nine original typographic covers. The library is the home page. No invented streaks, reading statistics or social proof. Imported books open their supplied text; the original sample remains labelled separately. The interface distinguishes local reading and browser storage from future account synchronisation.

## Verification approach
Check production build, keyboard controls, catalogue filtering, saving, reader progress persistence, book details and sign-in preview. Verify imported editions through their reader routes and check that saved positions remain separate between books. The browser skill's connection is attempted first. If unavailable, use the available documented browser connection and record that limitation. Local preview only; public hosting is outside this request.

## Initial mock-up evidence
The following records refer to the earlier five-book catalogue and original sample, before the eight EPUB imports. They are retained as design history and do not establish verification of the new editions.

- Production build and TypeScript checks pass.
- Static audit: 9 pages, 0 failures, 0 warnings; approximately 324 KB for the heaviest page.
- Axe checks: 0 violations on home, book details, saved books, reader, about and 404. No horizontal overflow at the measured mobile viewport. Separate dark-reader check also passes.
- Tested category filtering, saved books, chapter selection, text size, light/dark appearance, bookmark creation, reload resume and saved-passage return links. Escape closes dialogs and restores trigger focus; Tab reaches reading controls.
- Native Next.js navigation replaced the custom transition interceptor after a saved-passage navigation failure. Text stays at full opacity during entry.
- Reduced-motion behaviour is implemented and source reviewed. The browser connection did not expose motion emulation or CPU/network throttling, so reduced-motion visual verification and throttled performance remain unverified. Positive local timing values are unthrottled; LCP 0 means unavailable.
- Independent final evidence review: 7.1/10, recorded in `.shots/pass2/critic-review.txt`. The review is a mock-up critique, not an official Awwwards score. Remaining improvements concern early availability messaging, sign-in preview wording, the saved-passages layout and paragraph bookmark instructions. The eight-point target was not achieved.
- The final accessory removed was the reader's vertical decorative caption.
