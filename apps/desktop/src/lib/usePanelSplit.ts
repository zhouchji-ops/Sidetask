import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { setInteractionLock } from './native';

const clamp = (value: number) => Math.round(Math.max(30, Math.min(70, value)));
type Gesture = { type: 'pointer'; id: number } | { type: 'keyboard' };
type Draft = { base: number; value: number };
type Failure = 'write' | 'conflict' | null;

/** A divider previews locally and commits once, when its gesture ends. */
export function usePanelSplit(saved: number, busy: boolean, commit: (value: number) => Promise<void>, onWindowError: (message: string) => void) {
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  const latest = useRef({ saved, busy, commit, onWindowError });
  latest.current = { saved, busy, commit, onWindowError };
  const divider = useRef<HTMLDivElement>(null);
  const draft = useRef<Draft | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const ownsLock = useRef(false);
  const lockQueue = useRef<Promise<unknown>>(Promise.resolve());

  function lock(locked: boolean) {
    ownsLock.current = locked;
    lockQueue.current = lockQueue.current.catch(() => {}).then(() => setInteractionLock(locked));
    void lockQueue.current.catch(reason => { if (alive.current) latest.current.onWindowError(String(reason)); });
  }
  useEffect(() => {
    if (gesture.current || inFlight.current) return;
    const current = draft.current;
    if (!current) setValue(saved);
    else if (failure) {
      if (saved === current.value) {
        const previousFocus = document.activeElement;
        draft.current = null;
        setValue(saved);
        setFailure(null);
        focusAfterControlsDisappear(previousFocus);
      } else setFailure(saved !== current.base ? 'conflict' : 'write');
    }
  }, [saved, saving, failure]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      gesture.current = null;
      if (ownsLock.current) lock(false);
    };
  }, []);

  function focusAfterControlsDisappear(previous: Element | null) {
    requestAnimationFrame(() => {
      if (alive.current && document.hasFocus() && previous && !previous.isConnected && (document.activeElement === document.body || !document.activeElement?.isConnected)) divider.current?.focus({ preventScroll: true });
    });
  }
  function discard() {
    if (inFlight.current) return;
    const previousFocus = document.activeElement;
    draft.current = null;
    gesture.current = null;
    setValue(latest.current.saved);
    setFailure(null);
    focusAfterControlsDisappear(previousFocus);
    if (ownsLock.current) lock(false);
  }
  async function save(rebase = false) {
    const current = draft.current;
    if (!current || inFlight.current) return;
    gesture.current = null;
    if (current.value === latest.current.saved) { discard(); return; }
    if (rebase) current.base = latest.current.saved;
    if (current.base !== latest.current.saved) {
      setFailure('conflict');
      if (ownsLock.current) lock(false);
      return;
    }
    if (latest.current.busy) {
      setFailure('write');
      if (ownsLock.current) lock(false);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const previousFocus = document.activeElement;
    if (!ownsLock.current) lock(true);
    try {
      await latest.current.commit(current.value);
      draft.current = null;
      if (alive.current) {
        setFailure(null);
        focusAfterControlsDisappear(previousFocus);
      }
    } catch {
      if (alive.current) {
        setFailure(current.base !== latest.current.saved ? 'conflict' : 'write');
        requestAnimationFrame(() => {
          if (previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.matches(':disabled') && (document.activeElement === document.body || !document.activeElement?.isConnected)) previousFocus.focus({ preventScroll: true });
        });
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setSaving(false);
      if (ownsLock.current) lock(false);
    }
  }
  function begin(next: Gesture) {
    if (latest.current.busy || inFlight.current || draft.current || gesture.current) return false;
    draft.current = { base: latest.current.saved, value: latest.current.saved };
    gesture.current = next;
    setValue(latest.current.saved);
    setFailure(null);
    lock(true);
    return true;
  }
  function preview(next: number) {
    if (!draft.current) return;
    draft.current.value = clamp(next);
    setValue(draft.current.value);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !begin({ type: 'pointer', id: event.pointerId })) return;
    event.preventDefault();
    event.currentTarget.focus();
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch { discard(); }
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.type !== 'pointer' || gesture.current.id !== event.pointerId) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    const divider = event.currentTarget.getBoundingClientRect();
    if (bounds && bounds.height > divider.height) preview((event.clientY - bounds.top - divider.height / 2) / (bounds.height - divider.height) * 100);
  }
  function pointerEnd(event: PointerEvent<HTMLDivElement>, cancelled: boolean) {
    if (gesture.current?.type !== 'pointer' || gesture.current.id !== event.pointerId) return;
    // Clear before release: lostpointercapture must not cancel a completed save.
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) discard(); else void save();
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && gesture.current?.type === 'keyboard') {
      event.preventDefault(); event.stopPropagation(); discard(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (gesture.current?.type === 'pointer' || inFlight.current || latest.current.busy) return;
    if (!gesture.current && !begin({ type: 'keyboard' })) return;
    const next = event.key === 'Home' ? 30 : event.key === 'End' ? 70 : (draft.current?.value ?? latest.current.saved) + (event.key === 'ArrowDown' ? 5 : -5);
    preview(next);
  }
  function finishKeyboard() {
    if (gesture.current?.type === 'keyboard') { gesture.current = null; void save(); }
  }
  // Losing the application while a key is held must not leave an edit/hover lock.
  const blurAction = useRef(() => {});
  blurAction.current = () => { if (gesture.current?.type === 'pointer') discard(); else finishKeyboard(); };
  useEffect(() => {
    const blur = () => blurAction.current();
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, []);

  return {
    value, saving, failure,
    retry: () => void save(failure === 'conflict'), discard,
    dividerProps: {
      ref: divider,
      'aria-disabled': busy || saving || !!failure,
      onPointerDown: pointerDown,
      onPointerMove: pointerMove,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => pointerEnd(event, false),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => pointerEnd(event, true),
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => pointerEnd(event, true),
      onKeyDown: keyDown,
      onKeyUp: (event: KeyboardEvent<HTMLDivElement>) => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) finishKeyboard(); },
      onBlur: finishKeyboard,
    },
  };
}
