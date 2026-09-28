import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { setInteractionLock } from './native';

export interface TaskReorder<T> {
  revision: number;
  /** Includes the list identity and, for today, its calendar date. */
  context: string;
  disabled?: boolean;
  title: (item: T) => string;
  commit: (ids: string[], expectedRevision: number) => Promise<unknown>;
  prepare?: () => Promise<unknown>;
  protectPanel?: boolean;
}
type Preparation = { owner: symbol; cancelled: boolean; locked: boolean };
type Gesture = {
  id: string; pointer: number; button: HTMLButtonElement;
  ids: string[]; revision: number; context: string;
  startX: number; startY: number; x: number; y: number;
  active: boolean; slot: number; ready: Promise<boolean>; preparation: Preparation;
};
type Marker = { id: string; slot: number };

/** Keep committed rows in place while displaying an insertion line. Only the
 * final drop writes, with the revision observed at pointer-down. */
export function useTaskReorder<T extends { id: string }>(
  items: readonly T[], config: TaskReorder<T> | undefined,
  root: RefObject<HTMLDivElement | null>, scrollRef: RefObject<HTMLElement | null>,
  rows: RefObject<Map<string, HTMLDivElement>>, onMoved: (index: number) => void,
) {
  const latest = useRef({ items, config, onMoved });
  latest.current = { items, config, onMoved };
  const gesture = useRef<Gesture | null>(null);
  const preparations = useRef(new Set<Preparation>());
  const pendingCommit = useRef<Preparation | null>(null);
  const frame = useRef(0);
  const alive = useRef(true);
  const inflight = useRef(false);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  function release(preparation: Preparation) {
    preparation.cancelled = true;
    preparations.current.delete(preparation);
    if (!preparation.locked) return;
    preparation.locked = false;
    void setInteractionLock(false, preparation.owner).catch(reason => {
      if (alive.current) setNotice({ text: `窗口交互恢复失败：${String(reason)}`, error: true });
    });
  }
  function newPreparation(): Preparation {
    const preparation = { owner: Symbol('task-reorder'), cancelled: false, locked: false };
    preparations.current.add(preparation);
    return preparation;
  }
  async function prepare(preparation: Preparation, current: TaskReorder<T>) {
    if (current.protectPanel) {
      preparation.locked = true;
      await setInteractionLock(true, preparation.owner);
    }
    // A cancelled native request can finish after another drag has started.
    // Its owner and focus request must never affect that newer session.
    if (preparation.cancelled || !alive.current || !valid(current.revision, current.context)) return false;
    await current?.prepare?.();
    return !preparation.cancelled && alive.current;
  }
  function detach() {
    const current = gesture.current;
    gesture.current = null;
    cancelAnimationFrame(frame.current);
    if (current?.button.hasPointerCapture(current.pointer)) current.button.releasePointerCapture(current.pointer);
    if (alive.current) setMarker(null);
    return current;
  }
  function cancel(message?: string) {
    const current = gesture.current;
    const pending = pendingCommit.current;
    if (!current && !pending) return;
    detach();
    if (current) release(current.preparation);
    if (pending) { release(pending); pendingCommit.current = null; }
    if (message && alive.current) setNotice({ text: message });
  }
  function valid(revision: number, context: string) {
    const current = latest.current.config;
    return !!current && !current.disabled && current.revision === revision && current.context === context
      && !root.current?.closest('[inert]');
  }
  function bounds() {
    const list = root.current?.getBoundingClientRect();
    const viewport = scrollRef.current?.getBoundingClientRect();
    if (!list || !viewport) return null;
    return { top: Math.max(0, list.top, viewport.top), bottom: Math.min(window.innerHeight, list.bottom, viewport.bottom),
      left: Math.max(0, list.left, viewport.left), right: Math.min(window.innerWidth, list.right, viewport.right) };
  }
  function target(current: Gesture) {
    const measured = [...rows.current.entries()].map(([id, row]) => ({ id, index: Number(row.dataset.taskListIndex), rect: row.getBoundingClientRect() }))
      .filter(item => item.rect.height > 0).sort((a, b) => a.index - b.index);
    const next = measured.find(item => current.y < item.rect.top + item.rect.height / 2);
    current.slot = next?.index ?? (measured.length ? measured[measured.length - 1].index + 1 : current.ids.indexOf(current.id));
    setMarker(previous => previous?.id === current.id && previous.slot === current.slot ? previous : { id: current.id, slot: current.slot });
  }
  function tick() {
    const current = gesture.current;
    if (!current?.active) return;
    if (!valid(current.revision, current.context)) { cancel('列表已更新，已取消本次排序，请重试。'); return; }
    const area = bounds(); const scroll = scrollRef.current;
    if (area && scroll && current.x >= area.left && current.x <= area.right && current.y >= area.top - 24 && current.y <= area.bottom + 24) {
      const band = Math.min(40, (area.bottom - area.top) / 3);
      const velocity = current.y < area.top + band ? -Math.min(18, (area.top + band - current.y) * .45)
        : current.y > area.bottom - band ? Math.min(18, (current.y - area.bottom + band) * .45) : 0;
      if (velocity) scroll.scrollTop += velocity;
      target(current);
    }
    frame.current = requestAnimationFrame(tick);
  }
  async function commit(ids: string[], revision: number, context: string, moved: string, ready: Promise<boolean>, preparation: Preparation) {
    pendingCommit.current = preparation;
    inflight.current = true; setSaving(true);
    try {
      if (!await ready || preparation.cancelled || !alive.current) return;
      if (!valid(revision, context)) { setNotice({ text: '列表已更新，已取消本次排序，请重试。' }); return; }
      pendingCommit.current = null;
      await latest.current.config!.commit(ids, revision);
      if (alive.current) {
        setNotice({ text: '顺序已保存' });
        latest.current.onMoved(ids.indexOf(moved));
      }
    } catch (reason) {
      if (alive.current) setNotice({ text: `顺序未保存，请重试。${reason instanceof Error ? reason.message : String(reason)}`, error: true });
    } finally {
      if (pendingCommit.current === preparation) pendingCommit.current = null;
      inflight.current = false; release(preparation);
      if (alive.current) setSaving(false);
    }
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>, id: string) {
    const current = latest.current.config;
    if (event.button !== 0 || !event.isPrimary || !current || current.disabled || inflight.current || gesture.current || items.length < 2) return;
    event.preventDefault(); event.stopPropagation();
    const button = event.currentTarget;
    button.focus({ preventScroll: true });
    const session: Gesture = { id, pointer: event.pointerId, button, ids: items.map(item => item.id), revision: current.revision,
      context: current.context, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      active: false, slot: items.findIndex(item => item.id === id), ready: Promise.resolve(true), preparation: newPreparation() };
    // Keep the previous feedback's space until the next result. Removing it
    // here would shift the rows out from under the pointer on mouse-down.
    gesture.current = session;
    try { button.setPointerCapture(event.pointerId); }
    catch { cancel('无法开始拖动，请重试。'); return; }
    session.ready = prepare(session.preparation, current).catch(reason => {
      if (session.preparation.cancelled) return false;
      if (gesture.current === session || pendingCommit.current === session.preparation) cancel();
      else release(session.preparation);
      if (alive.current) setNotice({ text: `无法开始排序：${String(reason)}`, error: true });
      return false;
    });
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) >= 5) {
      current.active = true;
      target(current);
      frame.current = requestAnimationFrame(tick);
    }
  }
  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    current.x = event.clientX; current.y = event.clientY;
    const area = bounds();
    if (!current.active || !area || current.x < area.left || current.x > area.right || current.y < area.top || current.y > area.bottom) { cancel(); return; }
    target(current); detach();
    const from = current.ids.indexOf(current.id);
    const to = current.slot > from ? current.slot - 1 : current.slot;
    if (from === to) { release(current.preparation); return; }
    const ids = [...current.ids]; ids.splice(from, 1); ids.splice(to, 0, current.id);
    void commit(ids, current.revision, current.context, current.id, current.ready, current.preparation);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    const current = latest.current.config;
    if (!current || current.disabled || inflight.current || gesture.current || event.nativeEvent.isComposing) return;
    if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const ids = items.map(item => item.id); const from = ids.indexOf(id);
    const to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    const preparation = newPreparation();
    const ready = prepare(preparation, current);
    void commit(ids, current.revision, current.context, id, ready, preparation);
  }
  useLayoutEffect(() => {
    const current = gesture.current;
    if (current && !valid(current.revision, current.context)) cancel('列表已更新，已取消本次排序，请重试。');
  });
  useEffect(() => {
    alive.current = true;
    const key = (event: globalThis.KeyboardEvent) => {
      if ((gesture.current || pendingCommit.current) && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); event.stopImmediatePropagation(); cancel('已取消排序');
      }
    };
    const blur = () => cancel();
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      alive.current = false; detach();
      for (const preparation of preparations.current) release(preparation);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  return { marker, saving, notice, dismiss: () => setNotice(null), pointerDown, pointerMove, pointerUp, keyDown,
    pointerCancel: (event: PointerEvent<HTMLButtonElement>) => { if (gesture.current?.pointer === event.pointerId) cancel(); } };
}
