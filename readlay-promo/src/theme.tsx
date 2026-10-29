import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  Easing,
  staticFile,
} from "remotion";
import type { CSSProperties, ReactNode } from "react";

export const colour = {
  paper: "#F7F8F5",
  ink: "#252D28",
  green: "#315B45",
  pale: "#E8EEE5",
  muted: "#647067",
  line: "#DDE2DA",
  gold: "#D5B96C",
};
export const serif = "Newsreader, Georgia, serif";
export const sans = "Manrope, sans-serif";
export const ease = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
  easing: Easing.bezier(0.16, 1, 0.3, 1),
} as const;
export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

// Hold rendering until both local variable fonts have loaded.
if (typeof document !== "undefined") {
  const handle = delayRender("Readlay fonts");
  Promise.all([
    new FontFace(
      "Newsreader",
      `url(${staticFile("fonts/newsreader-200_800-normal.woff2")})`,
      { weight: "200 800" },
    ).load(),
    new FontFace(
      "Manrope",
      `url(${staticFile("fonts/manrope-200_800-normal.woff2")})`,
      { weight: "200 800" },
    ).load(),
  ])
    .then((fonts) => {
      fonts.forEach((font) => document.fonts.add(font));
      continueRender(handle);
    })
    .catch(cancelRender);
}

export const Stage = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => (
  <AbsoluteFill
    style={{
      backgroundColor: colour.paper,
      color: colour.ink,
      fontFamily: sans,
      overflow: "hidden",
      ...style,
    }}
  >
    {children}
  </AbsoluteFill>
);

export const Mark = ({
  size = 46,
  light = false,
}: {
  size?: number;
  light?: boolean;
}) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none">
    <rect
      width="64"
      height="64"
      rx="15"
      fill={light ? colour.paper : colour.green}
    />
    <path
      d="M17 16h13v34l-6.5-5-6.5 5zm18 0h13v28l-6.5-5-6.5 5z"
      fill={light ? colour.green : colour.paper}
    />
  </svg>
);

export const Brand = ({
  light = false,
  style,
}: {
  light?: boolean;
  style?: CSSProperties;
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 14,
      fontSize: 38,
      fontWeight: 750,
      letterSpacing: -1.8,
      color: light ? colour.paper : colour.green,
      ...style,
    }}
  >
    <Mark light={light} />
    readlay
    <span style={{ color: light ? colour.gold : "#A1843C", marginLeft: -12 }}>
      .
    </span>
  </div>
);

export const PlayIcon = ({
  size = 22,
  pause = false,
}: {
  size?: number;
  pause?: boolean;
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    {pause ? (
      <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
    ) : (
      <path d="M6 3.5 21 12 6 20.5z" />
    )}
  </svg>
);

export const Arrow = ({ size = 28 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 12h16m-6-6 6 6-6 6" />
  </svg>
);
