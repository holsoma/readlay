"use client";
import { useEffect, useState } from "react";
// Opt-in local QA. The accessibility library is not loaded in a normal visit.
export function QualityCheck() {
  const [report, setReport] = useState("");
  useEffect(() => {
    if (!new URLSearchParams(location.search).has("__qa")) return;
    let cancelled = false;
    async function check() {
      // Account progress loads after navigation. Audit the chapter once it is visible.
      if (location.pathname.startsWith("/read/")) {
        for (let attempt = 0; attempt < 60 && !document.querySelector(".reader-main h1"); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (cancelled) return;
        }
      }
      let lcp = 0; let cls = 0;
      const paintObserver = new PerformanceObserver((list) => { for (const entry of list.getEntries()) lcp = entry.startTime; });
      const shiftObserver = new PerformanceObserver((list) => { for (const entry of list.getEntries()) { const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }; if (!shift.hadRecentInput) cls += shift.value || 0; } });
      paintObserver.observe({ type: "largest-contentful-paint", buffered: true });
      shiftObserver.observe({ type: "layout-shift", buffered: true });
      await document.fonts.ready;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const axe = (await import("axe-core")).default;
      const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "best-practice"] } });
      paintObserver.disconnect(); shiftObserver.disconnect();
      if (!cancelled) setReport(JSON.stringify({ url: location.pathname, origin: location.origin, headings: [...document.querySelectorAll("h1")].map((heading) => heading.textContent), viewport: { width: innerWidth, height: innerHeight }, overflowX: document.documentElement.scrollWidth > innerWidth, lcpMs: lcp, cls, measurement: "Unthrottled browser", violations: result.violations.map((v) => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })) })), passes: result.passes.length }));
    }
    check().catch((error) => { if (!cancelled) setReport(JSON.stringify({ error: String(error) })); });
    return () => { cancelled = true; };
  }, []);
  return <output id="readlay-qa" hidden>{report}</output>;
}
