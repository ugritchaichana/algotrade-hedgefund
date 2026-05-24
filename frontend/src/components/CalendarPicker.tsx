import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  value: string;                 // YYYY-MM-DD (empty = no selection)
  onChange: (iso: string) => void;
  min?: string;                  // YYYY-MM-DD inclusive
  max?: string;                  // YYYY-MM-DD inclusive
  disabled?: boolean;
  placeholder?: string;
  rangeStart?: string;           // for visualizing a selected range in this calendar
  rangeEnd?: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const toIso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s?: string): Date | null => {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
};

const CalendarPicker: React.FC<Props> = ({ value, onChange, min, max, disabled, placeholder = 'Select date', rangeStart, rangeEnd }) => {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = fromIso(value) || fromIso(min) || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const ref = useRef<HTMLDivElement>(null);

  const minDate = useMemo(() => fromIso(min), [min]);
  const maxDate = useMemo(() => fromIso(max), [max]);
  const rangeStartDate = useMemo(() => fromIso(rangeStart), [rangeStart]);
  const rangeEndDate = useMemo(() => fromIso(rangeEnd), [rangeEnd]);

  // Re-center the view when value changes from outside (e.g. range auto-fill)
  useEffect(() => {
    const d = fromIso(value);
    if (d) setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [value]);

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const todayIso = toIso(new Date());
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const firstDow = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1).getDay();

  // Build grid: leading blanks + days 1..N
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const cellDate = (d: number) => new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d);

  const isOutsideAllowed = (d: number) => {
    const c = cellDate(d);
    if (minDate && c < minDate) return true;
    if (maxDate && c > maxDate) return true;
    return false;
  };
  const isSelected = (d: number) => toIso(cellDate(d)) === value;
  const isToday = (d: number) => toIso(cellDate(d)) === todayIso;
  const isInRange = (d: number) => {
    if (!rangeStartDate || !rangeEndDate) return false;
    const c = cellDate(d);
    return c >= rangeStartDate && c <= rangeEndDate;
  };
  const isRangeEdge = (d: number) => {
    const iso = toIso(cellDate(d));
    return iso === rangeStart || iso === rangeEnd;
  };

  const monthFirst = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const monthLast = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
  const canGoPrev = !minDate || monthFirst > minDate;
  const canGoNext = !maxDate || monthLast < maxDate;

  const goPrev = () => {
    if (!canGoPrev) return;
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  };
  const goNext = () => {
    if (!canGoNext) return;
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));
  };

  const jumpToMin = () => { if (minDate) { setViewMonth(new Date(minDate.getFullYear(), minDate.getMonth(), 1)); onChange(toIso(minDate)); setOpen(false); } };
  const jumpToMax = () => { if (maxDate) { setViewMonth(new Date(maxDate.getFullYear(), maxDate.getMonth(), 1)); onChange(toIso(maxDate)); setOpen(false); } };

  const handlePick = (d: number) => {
    if (isOutsideAllowed(d)) return;
    onChange(toIso(cellDate(d)));
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={`w-full bg-background border border-surfaceLight rounded px-3 py-2 text-text text-left disabled:opacity-50 flex items-center gap-2 hover:border-primary/50 transition-colors ${open ? 'border-primary' : ''}`}
      >
        <Calendar size={14} className="text-textMuted shrink-0" />
        <span className={value ? 'text-text' : 'text-textMuted'}>{value || placeholder}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-surface border border-surfaceLight rounded-lg p-3 z-50 shadow-2xl w-72 select-none">
          {/* Header */}
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={goPrev}
              disabled={!canGoPrev}
              className="text-textMuted hover:text-text p-1 disabled:opacity-30 disabled:cursor-not-allowed rounded"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="font-semibold text-text text-sm">
              {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
            </div>
            <button
              onClick={goNext}
              disabled={!canGoNext}
              className="text-textMuted hover:text-text p-1 disabled:opacity-30 disabled:cursor-not-allowed rounded"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Day-of-week header */}
          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {DAY_NAMES.map(n => (
              <div key={n} className="text-center text-[10px] text-textMuted font-semibold py-1 uppercase">{n}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((d, i) => {
              if (d === null) return <div key={`b${i}`} />;
              const outside = isOutsideAllowed(d);
              const sel = isSelected(d);
              const today = isToday(d);
              const inRange = isInRange(d);
              const edge = isRangeEdge(d);
              return (
                <button
                  key={i}
                  onClick={() => handlePick(d)}
                  disabled={outside}
                  className={`text-xs py-1.5 rounded transition-colors ${
                    sel
                      ? 'bg-primary text-white font-bold ring-2 ring-primary/40'
                      : edge
                        ? 'bg-primary/40 text-primary font-bold'
                        : inRange
                          ? 'bg-primary/15 text-primary'
                          : today
                            ? 'bg-warning/20 text-warning font-bold'
                            : outside
                              ? 'text-textMuted/20 cursor-not-allowed'
                              : 'text-text hover:bg-surfaceLight'
                  }`}
                  title={outside ? 'No data outside available range' : undefined}
                >
                  {d}
                </button>
              );
            })}
          </div>

          {/* Quick jump footer */}
          {(min || max) && (
            <div className="mt-3 pt-2 border-t border-surfaceLight flex justify-between items-center text-[10px]">
              <button onClick={jumpToMin} disabled={!min} className="text-primary hover:underline disabled:opacity-30" title={min}>
                Earliest: {min || '—'}
              </button>
              <button onClick={jumpToMax} disabled={!max} className="text-primary hover:underline disabled:opacity-30" title={max}>
                Latest: {max || '—'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CalendarPicker;
