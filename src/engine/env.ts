export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const ease = { out: "power3.out", inOut: "power3.inOut", soft: "power3.out" } as const;
