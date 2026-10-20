import { gsap } from "gsap";
import Lenis from "lenis";
import { prefersReducedMotion, ease } from "./env";
let context: gsap.Context | null = null;
let lenis: Lenis | null = null;
const tick = (time: number) => lenis?.raf(time * 1000);
export function cleanup() { context?.revert(); context = null; lenis?.destroy(); lenis = null; gsap.ticker.remove(tick); }
export function onPage() {
  cleanup();
  if (prefersReducedMotion()) return;
  if (!location.pathname.startsWith("/read") && matchMedia("(pointer: fine)").matches) { lenis = new Lenis({ autoRaf: false, anchors: true, duration: 0.7 }); gsap.ticker.add(tick); }
  context = gsap.context(() => { gsap.fromTo("[data-page]", { y: 7 }, { y: 0, duration: 0.32, ease: ease.out, clearProps: "all" }); });
}
export function boot() { onPage(); }
export async function leave() {
  if (prefersReducedMotion()) return;
  await gsap.fromTo("#curtain", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12, ease: ease.soft });
}
export function enter() { onPage(); gsap.to("#curtain", { autoAlpha: 0, duration: prefersReducedMotion() ? 0 : 0.2, ease: ease.out }); document.getElementById("main")?.focus({ preventScroll: true }); }
