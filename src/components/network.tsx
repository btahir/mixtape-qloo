"use client";
import { useSyncExternalStore } from "react";
const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};
export const useOnline = () =>
  useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
export function Network() {
  const online = useOnline();
  return online ? null : (
    <p role="alert">
      You are offline. You can read this view, but new choices and saves need a
      connection.
    </p>
  );
}
