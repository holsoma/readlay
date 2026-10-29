import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import {
  Arrow,
  Brand,
  colour,
  ease,
  Mark,
  PlayIcon,
  serif,
  Stage,
} from "./theme";

export const Closing = ({ poster = false }: { poster?: boolean }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Stage>
      <Brand style={{ position: "absolute", left: 90, top: 67 }} />
      <div
        style={{
          position: "absolute",
          right: 90,
          top: 80,
          color: colour.muted,
          fontSize: 23,
        }}
      >
        Ebooks + audiobooks
      </div>
      <div
        style={{
          position: "absolute",
          top: 225,
          left: 0,
          right: 0,
          textAlign: "center",
          translate: `0 ${poster ? 0 : interpolate(frame, [0, 0.6 * fps], [30, 0], ease)}px`,
          opacity: poster
            ? 1
            : interpolate(frame, [0, 0.4 * fps], [0, 1], ease),
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 24,
            alignItems: "center",
            marginBottom: 30,
          }}
        >
          <Mark size={62} />
          <div style={{ width: 95, height: 1, backgroundColor: colour.line }} />
          <div
            style={{
              color: colour.green,
              backgroundColor: colour.pale,
              width: 62,
              height: 62,
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
            }}
          >
            <PlayIcon size={29} />
          </div>
        </div>
        <h1
          style={{
            fontFamily: serif,
            fontSize: 122,
            fontWeight: 400,
            letterSpacing: -5,
            lineHeight: 0.98,
            margin: 0,
          }}
        >
          Read. Listen.
          <br />
          <span style={{ color: colour.green }}>Keep your place.</span>
        </h1>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 23,
            fontSize: 31,
            fontWeight: 550,
            color: colour.green,
            marginTop: 46,
            paddingBottom: 9,
            borderBottom: `1px solid ${colour.green}`,
          }}
        >
          readlay.vercel.app <Arrow />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 90,
          right: 90,
          bottom: 66,
          borderTop: `1px solid ${colour.line}`,
          paddingTop: 24,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 20,
          color: colour.muted,
        }}
      >
        <span>From the word you choose.</span>
        {poster ? (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              color: colour.green,
            }}
          >
            <PlayIcon size={17} />
            Watch the 15-second demo
          </span>
        ) : (
          <span>Your next chapter is waiting.</span>
        )}
      </div>
    </Stage>
  );
};

export const Poster = () => <Closing poster />;
