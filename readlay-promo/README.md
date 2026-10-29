# Readlay README video

A 15-second silent promo for Readlay's ebook and audiobook reader, built with Remotion 4.0.539. The video uses the application's colours, local Manrope and Newsreader fonts, bookmark mark and original cover artwork.

[Watch the MP4](../docs/media/readlay-promo.mp4) · [Animated preview](../docs/media/readlay-preview.gif) · [Still image](../docs/media/readlay-poster.png)

| Time      | Scene                                                        |
| --------- | ------------------------------------------------------------ |
| 0–3.5 s   | Book covers settle beside “Good books. Room to think.”       |
| 3.5–6.7 s | The reader selects “moment” and presses “Listen from here”.  |
| 6.7–12 s  | The word highlight, playback timer and progress bar advance. |
| 12–15 s   | “Read. Listen. Keep your place.” and the website address.    |

The reader is an animated illustration of the feature, not a screen recording. Its short passage is original demo text. No private book text, recordings, accounts or credentials are used. There is no audio track; the narration controls demonstrate the reading-to-listening handover visually.

## Preview and render

Use Node.js 22.13 or later. From this folder:

```powershell
npm ci
npm run dev
```

Open [Remotion Studio](http://localhost:3300/ReadlayPromo). The full video, poster and three individual scenes appear in the sidebar. Every animation is driven by the frame number, so seeking and rendering produce the same state.

```powershell
npm run lint
npm run render
npm run poster
```

The render commands write to `../docs/media/`. Output is 1600 × 900, 30 fps, 450 frames, H.264 MP4, yuv420p, CRF 20. Remotion obtains Chrome Headless Shell when no browser has been configured. To use an existing Chrome installation on Windows:

```powershell
npm run render -- --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe" --concurrency=2
npm run poster -- --browser-executable="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

## README inclusion

The repository README shows a looping GIF of the full video, linked to the original MP4. A `picture` source displays the still image when the viewer prefers reduced motion. For a simple Markdown embed:

```markdown
[![Watch Readlay: read, listen and keep your place](docs/media/readlay-preview.gif)](docs/media/readlay-promo.mp4)
```

Commit all three media files with the README. The animation plays inline as an image; selecting it opens the MP4.

To recreate the animated preview after rendering, run this from the repository root with FFmpeg installed:

```powershell
ffmpeg -y -i docs/media/readlay-promo.mp4 -filter_complex "[0:v]fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 docs/media/readlay-preview.gif
```

This separate project has its own lockfile and dependencies. It is excluded from the Next.js TypeScript checks, application linting and Vercel upload. The application dependency files are unchanged.

## Assets and licensing

Font licences are included in `public/fonts/`. The covers are Readlay's original concept artwork copied from the application, not publisher cover scans. See the repository's MIT licence for Readlay code and artwork, and Remotion's [licence terms](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) for the rendering framework.
