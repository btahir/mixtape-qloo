"use client";
import { useEffect, useState } from "react";
export function useCooldown(resetAt?: number) {
  const [expiredAt, setExpiredAt] = useState<number>();
  useEffect(() => {
    if (!resetAt) return;
    const timer = setTimeout(() => setExpiredAt(resetAt), Math.max(0, resetAt - Date.now()));
    return () => clearTimeout(timer);
  }, [resetAt]);
  return !!resetAt && resetAt !== expiredAt;
}

export function CooldownMessage({ resetAt }: { resetAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [resetAt]);
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
  return seconds ? `Try again in ${seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} sec`}.` : "You can try again now.";
}
