import type { TrackSort } from '../hooks/useTracks';

interface Tab {
  value: TrackSort;
  label: string;
}

const TABS: Tab[] = [
  { value: 'heap',  label: 'top of the heap' },
  { value: 'fresh', label: 'fresh lumps' },
  { value: 'alpha', label: 'a–z' },
];

interface Props {
  active: TrackSort;
  onChange: (next: TrackSort) => void;
}

export function SortTabs({ active, onChange }: Props) {
  return (
    <div className="scroll-strip flex flex-nowrap sm:flex-wrap gap-2 overflow-x-auto sm:overflow-x-visible -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 sm:pb-0 mb-4">
      {TABS.map((t) => {
        const isActive = active === t.value;
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            aria-pressed={isActive}
            className={`shrink-0 whitespace-nowrap h-11 sm:h-7 px-4 sm:px-3 text-xs sm:text-[10px] uppercase tracking-[0.2em] border transition-colors ${
              isActive
                ? 'bg-accent text-bg border-accent'
                : 'border-accent-dim text-accent hover:border-accent-bright hover:text-accent-bright'
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
