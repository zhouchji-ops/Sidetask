import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import '../styles/virtual-task-list.css';

export interface VirtualTaskListProps<T extends { id: string }> {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** The existing main-content / edge-scroll element; no nested scrollbar. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Pass on the primary list only, for query/page/sort changes. */
  resetKey?: string;
  estimateSize?: number;
  className?: string;
  label?: string;
}

type Focus = { id: string; index: number; control: number };
const controlsSelector = 'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
function controls(row: Element): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>(controlsSelector))
    .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
}

/** Dynamic-height task rendering. Every item remains reachable by scrolling,
 * Tab, arrows and Home/End; the focused row stays mounted outside the viewport.
 * Item IDs must be unique and stable, and renderItem must return normal content
 * rather than a second scrolling container. No task data is sliced or dropped. */
export function VirtualTaskList<T extends { id: string }>({ items, renderItem, scrollRef, resetKey, estimateSize = 72, className = '', label = '任务列表' }: VirtualTaskListProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [margin, setMargin] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [focused, setFocused] = useState<Focus | null>(null);
  const [request, setRequest] = useState<{ index: number; control: number } | null>(null);
  const indexById = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);
  const virtual = items.length > 80;
  const focusedIndex = focused ? indexById.get(focused.id) ?? Math.min(focused.index, items.length - 1) : -1;
  const getItemKey = useCallback((index: number) => items[index].id, [items]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const indexes = defaultRangeExtractor(range);
    for (const index of [focusedIndex, request?.index ?? -1]) {
      if (index >= 0 && index < items.length && !indexes.includes(index)) indexes.push(index);
    }
    return indexes.sort((a, b) => a - b);
  }, [focusedIndex, request?.index, items.length]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey,
    overscan: 6,
    scrollMargin: margin,
    rangeExtractor,
    enabled: virtual && mounted,
    // Preserve the visible ID when records before it are removed or inserted.
    // No automatic following of appended records in a task list.
    anchorTo: 'end',
    followOnAppend: false,
  });
  const previousReset = useRef<string | undefined>(undefined);
  // A ref owned by the parent is attached after this child's first layout
  // effects. Reconcile once after commit so the observer sees that container.
  useLayoutEffect(() => { setMounted(true); }, []);

  useLayoutEffect(() => {
    const element = root.current;
    const scroll = scrollRef.current;
    if (!element || !scroll) return;
    const update = () => {
      const next = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop;
      setMargin(value => Math.abs(value - next) > .5 ? next : value);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(scroll);
    // Earlier groups can resize without resizing the scroll viewport.
    for (const child of scroll.children) observer.observe(child);
    return () => observer.disconnect();
  }, [scrollRef, mounted]);
  useLayoutEffect(() => {
    const element = root.current; const scroll = scrollRef.current;
    if (element && scroll) {
      const next = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientTop + scroll.scrollTop;
      if (Math.abs(next - margin) > .5) setMargin(next);
    }
    if (scroll && previousReset.current !== resetKey) {
      previousReset.current = resetKey;
      scroll?.scrollTo({ top: 0, behavior: 'auto' });
    }
  });

  useLayoutEffect(() => {
    if (!focused || indexById.has(focused.id)) return;
    // Completion/removal must not strand keyboard focus on document.body.
    // Do not steal it if a detail editor or another control has taken focus.
    if (document.activeElement === document.body || root.current?.contains(document.activeElement)) {
      if (items.length) setRequest({ index: Math.min(focused.index, items.length - 1), control: focused.control });
      else root.current?.focus({ preventScroll: true });
    }
    setFocused(null);
  }, [items, indexById, focused]);

  useLayoutEffect(() => {
    if (!request) return;
    const item = items[request.index];
    const row = item && rows.current.get(item.id);
    if (!row) return;
    if (virtual) virtualizer.scrollToIndex(request.index, { align: 'auto', behavior: 'auto' });
    else row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    const targets = controls(row);
    const target = targets[request.control < 0 ? targets.length - 1 : Math.min(request.control, targets.length - 1)];
    (target || row).focus({ preventScroll: true });
    setRequest(null);
  }, [request, items, virtual, virtualizer]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.matches('input,textarea,select') || target.isContentEditable) return;
    const row = target.closest<HTMLElement>('[data-task-list-index]');
    if (!row || !root.current?.contains(row)) return;
    const index = Number(row.dataset.taskListIndex);
    const targets = controls(row);
    const control = Math.max(0, targets.indexOf(target));
    let next = index;
    let nextControl = control;
    if (event.key === 'ArrowDown') next++;
    else if (event.key === 'ArrowUp') next--;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab' && (event.shiftKey ? target === targets[0] : target === targets.at(-1))) {
      next += event.shiftKey ? -1 : 1;
      nextControl = event.shiftKey ? -1 : 0;
    } else return;
    if (next < 0 || next >= items.length || (next === index && event.key !== 'Home' && event.key !== 'End')) return;
    event.preventDefault();
    setRequest({ index: next, control: nextControl });
  }

  function render(index: number, offset?: number) {
    const item = items[index];
    return <div key={item.id} role="listitem" aria-posinset={index + 1} aria-setsize={items.length}
      data-index={index} data-task-list-index={index} data-task-list-id={item.id}
      data-first={index === 0 || undefined} data-last={index === items.length - 1 || undefined}
      tabIndex={-1} className="virtual-task-item"
      ref={element => { if (element) rows.current.set(item.id, element); else rows.current.delete(item.id); if (virtual) virtualizer.measureElement(element); }}
      style={virtual ? { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${offset}px)` } : undefined}>
      {renderItem(item, index)}
    </div>;
  }

  return <div ref={root} role="list" aria-label={label} tabIndex={-1} data-virtualized={virtual}
    className={`virtual-task-list ${className}`} style={virtual ? { height: virtualizer.getTotalSize() } : undefined}
    onKeyDownCapture={onKeyDown}
    onFocusCapture={event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-task-list-index]');
      if (!row) return;
      setFocused({ id: row.dataset.taskListId!, index: Number(row.dataset.taskListIndex), control: Math.max(0, controls(row).indexOf(event.target as HTMLElement)) });
    }}
    onBlurCapture={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setFocused(null); }}>
    {virtual ? virtualizer.getVirtualItems().map(item => render(item.index, item.start - margin)) : items.map((_, index) => render(index))}
  </div>;
}
