"use client";
import { useLayoutEffect, useRef, type ReactNode } from "react";
export function FittedTitle({ title, className = "cover-title", children }: { title: string; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    let active = true;
    let previous = "";
    const fit = () => {
      if (!active) return;
      const max = Number.parseFloat(getComputedStyle(element).getPropertyValue("--cover-size")) || 50;
      const key = `${element.clientWidth}:${element.clientHeight}:${max}:${document.fonts.status}`;
      if (key === previous) return;
      previous = key;
      let low = 8, high = max;
      // Measure the actual font and available print area; metadata and all
      // artwork geometry stay outside this reserved title rectangle.
      for (let i = 0; i < 9; i++) {
        const size = (low + high) / 2;
        element.style.fontSize = `${size}px`;
        if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) high = size;
        else low = size;
      }
      element.style.fontSize = `${Math.floor(low * 10) / 10}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element.parentElement!);
    void document.fonts.ready.then(fit);
    return () => { active = false; observer.disconnect(); };
  }, [title]);
  return <div ref={ref} className={className}>{children ?? title}</div>;
}
