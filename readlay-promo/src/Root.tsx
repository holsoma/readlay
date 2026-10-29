import { Composition, Folder, Series, Still, useVideoConfig } from "remotion";
import { Bookshelf } from "./Bookshelf";
import { ReadAndListen } from "./ReadAndListen";
import { Closing, Poster } from "./Closing";

export const ReadlayPromo = () => {
  const { fps } = useVideoConfig();
  return (
    <Series>
      <Series.Sequence
        name="Your bookshelf"
        durationInFrames={3.5 * fps}
        premountFor={fps}
      >
        <Bookshelf />
      </Series.Sequence>
      <Series.Sequence
        name="Select a word and listen"
        durationInFrames={8.5 * fps}
        premountFor={fps}
      >
        <ReadAndListen />
      </Series.Sequence>
      <Series.Sequence
        name="Read. Listen. Keep your place."
        durationInFrames={3 * fps}
        premountFor={fps}
      >
        <Closing />
      </Series.Sequence>
    </Series>
  );
};

export const RemotionRoot = () => (
  <>
    <Composition
      id="ReadlayPromo"
      component={ReadlayPromo}
      durationInFrames={450}
      fps={30}
      width={1600}
      height={900}
    />
    <Still id="ReadlayPoster" component={Poster} width={1600} height={900} />
    <Folder name="Scenes">
      <Composition
        id="Bookshelf"
        component={Bookshelf}
        durationInFrames={105}
        fps={30}
        width={1600}
        height={900}
      />
      <Composition
        id="ReadAndListen"
        component={ReadAndListen}
        durationInFrames={255}
        fps={30}
        width={1600}
        height={900}
      />
      <Composition
        id="Closing"
        component={Closing}
        durationInFrames={90}
        fps={30}
        width={1600}
        height={900}
      />
    </Folder>
  </>
);
