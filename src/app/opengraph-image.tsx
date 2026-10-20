import { ImageResponse } from "next/og";
export const alt = "Readlay. Good books. Room to think.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export default function OpenGraphImage() { return new ImageResponse(<div style={{ background: "#e8eee5", color: "#252d28", width: "100%", height: "100%", padding: "70px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}><div style={{ fontSize: 35, fontWeight: 700 }}>readlay.</div><div style={{ fontSize: 98, letterSpacing: "-5px", lineHeight: 1.05, display: "flex", flexDirection: "column" }}><span>Good books.</span><span>Room to think.</span></div><div style={{ fontSize: 25 }}>A little time, a good book.</div></div>, size); }
