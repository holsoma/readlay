import {
  CanvasImage,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Arrow, Brand, colour, ease, serif, Stage } from "./theme";

const Book = ({
  file,
  left,
  top,
  width,
  tilt,
  delay,
}: {
  file: string;
  left: number;
  top: number;
  width: number;
  tilt: number;
  delay: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        height: width * 1.5,
        translate: `0 ${interpolate(frame, [delay * fps, (delay + 0.9) * fps], [110, 0], ease)}px`,
        rotate: `${interpolate(frame, [delay * fps, (delay + 0.9) * fps], [tilt + 6, tilt], ease)}deg`,
        opacity: interpolate(
          frame,
          [delay * fps, (delay + 0.5) * fps],
          [0, 1],
          ease,
        ),
        boxShadow: "10px 25px 38px #253d3128",
        borderRadius: "2px 5px 5px 2px",
      }}
    >
      <CanvasImage
        src={staticFile(`covers/${file}.svg`)}
        premountFor={fps}
        style={{ width: "100%", height: "100%", borderRadius: "inherit" }}
      />
      <div
        style={{
          position: "absolute",
          left: 9,
          top: 0,
          bottom: 0,
          width: 2,
          background: "#ffffff20",
        }}
      />
    </div>
  );
};

export const Bookshelf = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Stage>
      <Brand style={{ position: "absolute", left: 90, top: 67 }} />
      <div
        style={{
          position: "absolute",
          right: 92,
          top: 80,
          fontSize: 24,
          color: colour.muted,
        }}
      >
        Your reading, continued.
      </div>
      <div
        style={{
          position: "absolute",
          left: 90,
          top: 246,
          zIndex: 2,
          translate: `0 ${interpolate(frame, [0, 0.7 * fps], [28, 0], ease)}px`,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 650,
            letterSpacing: 3.2,
            color: colour.green,
            marginBottom: 34,
          }}
        >
          EBOOKS + AUDIOBOOKS
        </div>
        <h1
          style={{
            fontFamily: serif,
            fontSize: 118,
            fontWeight: 400,
            lineHeight: 0.98,
            letterSpacing: -5,
            margin: 0,
          }}
        >
          Good books.
          <br />
          Room to think.
        </h1>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            fontSize: 30,
            color: colour.muted,
            marginTop: 45,
            opacity: interpolate(frame, [0.45 * fps, 1 * fps], [0, 1], ease),
          }}
        >
          Read. Listen. Keep your place. <Arrow />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          width: 550,
          height: 550,
          left: 940,
          top: 221,
          backgroundColor: colour.pale,
          borderRadius: "50%",
        }}
      />
      <Book
        file="the-5-am-club"
        left={1110}
        top={235}
        width={275}
        tilt={12}
        delay={0.1}
      />
      <Book
        file="the-power-of-now"
        left={900}
        top={250}
        width={285}
        tilt={-12}
        delay={0.18}
      />
      <Book
        file="atomic-habits"
        left={1055}
        top={285}
        width={302}
        tilt={3}
        delay={0.28}
      />
      <div
        style={{
          position: "absolute",
          left: 1280,
          top: 285,
          width: 29,
          height: 95,
          backgroundColor: colour.gold,
          clipPath: "polygon(0 0,100% 0,100% 100%,50% 81%,0 100%)",
          rotate: "3deg",
          scale: `1 ${interpolate(frame, [0.7 * fps, 1.25 * fps], [0, 1], ease)}`,
          transformOrigin: "top",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 90,
          right: 90,
          bottom: 70,
          borderTop: `1px solid ${colour.line}`,
          paddingTop: 23,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 20,
          color: colour.muted,
        }}
      >
        <span>A library for the way you read.</span>
        <span>readlay.vercel.app</span>
      </div>
    </Stage>
  );
};
