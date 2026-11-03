import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  /** Tailwind max-width class applied at md+ (mobile is always full-screen).
   *  Must be a literal class name so Tailwind's JIT can pick it up.
   *  Defaults to md:max-w-lg. */
  maxWidthMd?: string;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="button"]:not([aria-disabled="true"])';

export function Modal({ open, onClose, children, title, maxWidthMd = 'md:max-w-lg' }: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Keep onClose in a ref so the focus-management effect below doesn't re-run
  // (and steal focus back to the trigger) every time a parent re-render hands
  // us a fresh onClose function — e.g. inline `() => setOpen(false)` callers.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;

    triggerRef.current = (document.activeElement as HTMLElement) || null;

    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) focusables[0].focus();
      else panel.focus();
    };
    const id = window.setTimeout(focusFirst, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.clearTimeout(id);
      window.removeEventListener('keydown', onKey);
      // Restore focus to whatever opened us.
      const t = triggerRef.current;
      if (t && typeof t.focus === 'function') {
        try { t.focus(); } catch { /* element may have unmounted */ }
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch md:items-center justify-center bg-black/80 p-0 md:p-4"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`w-full bg-bg border-0 md:border border-accent text-body outline-none
                    h-full md:h-auto overflow-y-auto md:overflow-visible
                    ${maxWidthMd}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-accent-dim">
            <div
              id={titleId}
              className="px-5 py-3 text-xs sm:text-[11px] uppercase tracking-[0.25em] text-accent"
            >
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="md:hidden mr-2 w-11 h-11 flex items-center justify-center text-accent-dim hover:text-accent-bright transition-colors"
            >
              <span aria-hidden="true" className="text-xl leading-none">×</span>
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
