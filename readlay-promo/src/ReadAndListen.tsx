import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Brand, clamp, colour, ease, PlayIcon, serif, Stage } from "./theme";

// Original promotional text, not an extract from a catalogue book.
const lines = [
  ["A", "quiet", "moment", "can", "change"],
  ["the", "way", "you", "read.", "Stay", "with"],
  ["a", "thought,", "then", "listen", "as"],
  ["the", "words", "carry", "on."],
];

const Cursor = () => (
  <svg
    width="38"
    height="48"
    viewBox="0 0 38 48"
    fill={colour.ink}
    stroke={colour.paper}
    strokeWidth="2.2"
  >
    <path d="M4 3v34l9-8 8 16 7-4-8-15 13-1z" />
  </svg>
);

export const ReadAndListen = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const playing = t >= 3.2;
  const selected = t >= 1.05;
  const spokenWord = playing
    ? Math.min(19, 2 + Math.floor((t - 3.2) / 0.29))
    : -1;
  const elapsed = Math.max(0, Math.floor(t - 3.2));

  return (
    <Stage style={{ backgroundColor: colour.green, color: colour.paper }}>
      <Brand light style={{ position: "absolute", left: 90, top: 67 }} />
      <div style={{ position: "absolute", left: 90, top: 245, width: 480 }}>
        <div
          style={{
            fontSize: 20,
            letterSpacing: 3,
            color: "#CBD7CB",
            fontWeight: 600,
            marginBottom: 35,
          }}
        >
          {playing ? "SAME BOOK. SAME PLACE." : "FROM PAGE TO AUDIO"}
        </div>
        <div style={{ position: "relative", height: 270 }}>
          <h2
            style={{
              position: "absolute",
              margin: 0,
              fontFamily: serif,
              fontSize: 110,
              lineHeight: 0.97,
              fontWeight: 400,
              letterSpacing: -4,
              opacity: interpolate(
                frame,
                [2.9 * fps, 3.15 * fps],
                [1, 0],
                clamp,
              ),
              translate: `0 ${interpolate(frame, [2.9 * fps, 3.15 * fps], [0, -18], ease)}px`,
            }}
          >
            Pick
            <br />a word.
          </h2>
          <h2
            style={{
              position: "absolute",
              margin: 0,
              fontFamily: serif,
              fontSize: 110,
              lineHeight: 0.97,
              fontWeight: 400,
              letterSpacing: -4,
              opacity: interpolate(
                frame,
                [3.15 * fps, 3.5 * fps],
                [0, 1],
                clamp,
              ),
              translate: `0 ${interpolate(frame, [3.15 * fps, 3.6 * fps], [25, 0], ease)}px`,
            }}
          >
            Listen
            <br />
            from here.
          </h2>
        </div>
        <div
          style={{
            fontSize: 29,
            lineHeight: 1.5,
            color: "#D5E0D4",
            maxWidth: 440,
          }}
        >
          {playing ? (
            <>
              Follow the narration,
              <br />
              word by word.
            </>
          ) : (
            <>
              Switch to prepared audio
              <br />
              at your selected word.
            </>
          )}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 635,
          top: 145,
          width: 875,
          height: 620,
          backgroundColor: colour.paper,
          color: colour.ink,
          borderRadius: 14,
          boxShadow: "0 25px 65px #122c2538",
          translate: `0 ${interpolate(frame, [0, 0.65 * fps], [36, 0], ease)}px`,
        }}
      >
        <div
          style={{
            height: 83,
            margin: "0 45px",
            borderBottom: `1px solid ${colour.line}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 21,
            color: colour.muted,
          }}
        >
          <span>Readlay reader</span>
          <span style={{ fontFamily: serif, fontSize: 30 }}>
            Aa{" "}
            <span
              style={{ fontFamily: "Manrope", fontSize: 20, marginLeft: 25 }}
            >
              ☼
            </span>
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 50,
            top: 116,
            fontSize: 16,
            color: colour.muted,
            letterSpacing: 2,
          }}
        >
          A MOMENT TO READ{" "}
          <span style={{ letterSpacing: 0, marginLeft: 26, color: "#829083" }}>
            Original demo text
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            left: 45,
            top: 166,
            right: 35,
            fontFamily: serif,
            fontSize: 46,
            lineHeight: 1.5,
            letterSpacing: -0.8,
          }}
        >
          {lines.map((words, line) => {
            const offset = lines
              .slice(0, line)
              .reduce((sum, row) => sum + row.length, 0);
            return (
              <div key={line} style={{ whiteSpace: "nowrap" }}>
                {words.map((word, index) => {
                  const position = offset + index;
                  const isSelected = selected && !playing && position === 2;
                  const isSpoken = playing && position === spokenWord;
                  return (
                    <span
                      key={word + index}
                      style={{
                        display: "inline-block",
                        position: "relative",
                        padding: "0 4px",
                        marginRight: 3,
                        backgroundColor: isSelected
                          ? "#D5E4D0"
                          : isSpoken
                            ? colour.gold
                            : "transparent",
                        color:
                          playing && position < spokenWord
                            ? colour.muted
                            : colour.ink,
                        borderRadius: 4,
                      }}
                    >
                      {word}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div
          style={{
            position: "absolute",
            left: 85,
            top: 462,
            display: "flex",
            alignItems: "center",
            gap: 17,
            padding: "18px 25px",
            borderRadius: 9,
            color: colour.paper,
            backgroundColor: colour.green,
            fontSize: 26,
            fontWeight: 550,
            opacity: interpolate(
              frame,
              [1.15 * fps, 1.45 * fps, 3.1 * fps, 3.25 * fps],
              [0, 1, 1, 0],
              clamp,
            ),
            translate: `0 ${interpolate(frame, [1.15 * fps, 1.6 * fps], [16, 0], ease)}px`,
          }}
        >
          <PlayIcon />
          Listen from here
        </div>

        <div
          style={{
            position: "absolute",
            left: 37,
            right: 37,
            bottom: 30,
            height: 125,
            borderRadius: 10,
            backgroundColor: "#E8EEE5",
            padding: "23px 26px",
            boxSizing: "border-box",
            opacity: interpolate(frame, [3.2 * fps, 3.55 * fps], [0, 1], ease),
            translate: `0 ${interpolate(frame, [3.2 * fps, 3.7 * fps], [20, 0], ease)}px`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <div
              style={{
                width: 49,
                height: 49,
                borderRadius: "50%",
                backgroundColor: colour.green,
                color: colour.paper,
                display: "grid",
                placeItems: "center",
              }}
            >
              <PlayIcon pause size={20} />
            </div>
            <div style={{ fontSize: 24, fontWeight: 650 }}>
              Listening from “moment”
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 450,
                  color: colour.muted,
                  marginTop: 4,
                }}
              >
                Female narrator <span style={{ margin: "0 10px" }}>·</span> 1×
                speed
              </div>
            </div>
            <div
              style={{
                marginLeft: "auto",
                fontSize: 24,
                fontVariantNumeric: "tabular-nums",
                color: colour.green,
              }}
            >
              00:0{elapsed}
            </div>
          </div>
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 26,
              right: 26,
              height: 4,
              borderRadius: 2,
              backgroundColor: "#CCD8C8",
            }}
          >
            <div
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: colour.green,
                width: `${interpolate(frame, [3.2 * fps, 8.5 * fps], [5, 86], clamp)}%`,
              }}
            />
          </div>
        </div>

        <div
          style={{
            position: "absolute",
            left: interpolate(
              frame,
              [0.45 * fps, 1.05 * fps, 1.8 * fps, 2.75 * fps],
              [380, 295, 295, 330],
              ease,
            ),
            top: interpolate(
              frame,
              [0.45 * fps, 1.05 * fps, 1.8 * fps, 2.75 * fps],
              [360, 201, 201, 500],
              ease,
            ),
            opacity: interpolate(
              frame,
              [0.3 * fps, 0.55 * fps, 3.25 * fps, 3.55 * fps],
              [0, 1, 1, 0],
              clamp,
            ),
            scale: interpolate(
              frame,
              [2.95 * fps, 3.05 * fps, 3.2 * fps],
              [1, 0.84, 1],
              clamp,
            ),
          }}
        >
          <Cursor />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 90,
          bottom: 65,
          display: "flex",
          gap: 16,
          alignItems: "center",
          fontSize: 21,
          color: "#D5E0D4",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            backgroundColor: colour.gold,
            borderRadius: "50%",
          }}
        />
        Your place stays with you.
      </div>
    </Stage>
  );
};
