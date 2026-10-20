"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { boot, cleanup } from "@/engine";
export function Motion() {
  const pathname = usePathname(); const first = useRef(true);
  useEffect(() => { boot(); if (!first.current) document.getElementById("main")?.focus({ preventScroll: true }); first.current = false; return cleanup; }, [pathname]);
  return null;
}
