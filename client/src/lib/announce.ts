// Pushes a message into the global polite live region (mounted in App.tsx).
// Screen readers announce it without interrupting current speech.
//
// Errors should not go through this — they get their own role="alert" container
// at the source so the SR announces them assertively.

const REGION_ID = 'aria-live-status';

let resetTimer: number | null = null;

export function announce(message: string) {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(REGION_ID);
  if (!el) return;
  // Setting textContent to the same string twice in a row may be ignored by
  // some readers; clear it first then set it on the next tick so the change
  // is detected.
  el.textContent = '';
  window.requestAnimationFrame(() => {
    el.textContent = message;
  });
  if (resetTimer) window.clearTimeout(resetTimer);
  // Clear the message after a few seconds so stale announcements don't get
  // re-read if the SR cursor returns to the region.
  resetTimer = window.setTimeout(() => {
    if (el.textContent === message) el.textContent = '';
  }, 4000);
}
