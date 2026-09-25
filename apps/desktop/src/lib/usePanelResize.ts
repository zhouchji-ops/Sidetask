import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { sameSettings, setInteractionLock, windowAction } from './native';
import type { Settings } from './types';

type Size = { width: number; height: number };
type Gesture = {
  id: string; kind: 'pointer' | 'keyboard'; expected: Settings; initial: Size; size: Size;
  pointer?: { id: number; x: number; y: number; target: HTMLButtonElement };
  queue: Promise<unknown>; frame: number | null; previewQueued: boolean;
  attempted: boolean; started: boolean; closing: boolean; cancelled: boolean; failed: boolean; commitSent: boolean;
};
const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));

/** CSS-pixel drafts belong to one explicit native resize session. */
export function usePanelResize(settings: Settings | undefined, busy: boolean, onError: (message: string) => void) {
  const latest = useRef({ settings, busy, onError });
  latest.current = { settings, busy, onError };
  const active = useRef<Gesture | null>(null);
  const owner = useRef(Symbol('panel-resize'));
  const alive = useRef(true);
  const [finishing, setFinishing] = useState(false);
  // A command can resolve before its snapshot event reaches React. Subsequent
  // keystrokes must start from the size we just committed, never the old render.
  const committed = useRef<Settings[]>([]);

  function report(reason: unknown) {
    if (alive.current) latest.current.onError(reason instanceof Error ? reason.message : String(reason));
  }
  function end(gesture: Gesture, save: boolean) {
    if (gesture.closing) return;
    gesture.closing = true;
    gesture.cancelled = !save;
    if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
    gesture.frame = null;
    // Clear the gesture before releasing capture: its lost-capture notification
    // must not cancel an intentional pointer-up commit.
    const pointer = gesture.pointer;
    if (pointer?.target.hasPointerCapture(pointer.id)) pointer.target.releasePointerCapture(pointer.id);
    if (alive.current) setFinishing(true);
    void gesture.queue.then(async () => {
      if (save && !gesture.cancelled && !gesture.failed && gesture.started) {
        gesture.commitSent = true;
        await windowAction('resizePanel', { phase: 'commit', session: gesture.id, ...gesture.size });
        const observed = latest.current.settings ?? gesture.expected;
        const expected = { ...gesture.expected, panelWidth: gesture.size.width, panelHeight: gesture.size.height };
        const trail = committed.current;
        const knownBase = trail.length > 0 && sameSettings(trail[trail.length - 1], gesture.expected);
        if (knownBase && trail.some(value => sameSettings(value, observed))) committed.current = [...trail, expected];
        else if (sameSettings(observed, gesture.expected) || sameSettings(observed, expected)) committed.current = [gesture.expected, expected];
        else committed.current = []; // An unrelated setting arrived during commit.
      } else if (gesture.attempted) await windowAction('resizePanel', { phase: 'cancel', session: gesture.id });
    }).catch(async reason => {
      report(reason);
      if (gesture.attempted) {
        try { await windowAction('resizePanel', { phase: 'cancel', session: gesture.id }); }
        catch (cancelError) { report(cancelError); }
      }
    }).finally(async () => {
      try { await setInteractionLock(false, owner.current); } catch (reason) { report(reason); }
      if (active.current === gesture) active.current = null;
      if (alive.current) setFinishing(false);
    });
  }
  function enqueue(gesture: Gesture, operation: () => Promise<unknown>) {
    gesture.queue = gesture.queue.then(() => {
      if (!gesture.failed && !gesture.cancelled) return operation();
    }).catch(reason => {
      gesture.failed = true;
      if (!gesture.started) committed.current = [];
      report(reason);
      end(gesture, false);
    });
  }
  function begin(kind: Gesture['kind'], initial?: Size) {
    const saved = latest.current.settings;
    if (!saved || latest.current.busy || active.current) return null;
    const trail = committed.current;
    const expected = trail.some(value => sameSettings(saved, value)) ? trail[trail.length - 1] : saved;
    if (expected === saved) committed.current = [];
    const size = { width: expected.panelWidth, height: expected.panelHeight };
    const gesture: Gesture = {
      id: crypto.randomUUID(), kind, expected: { ...expected }, initial: { ...(initial ?? size) }, size: { ...size },
      queue: Promise.resolve(), frame: null, previewQueued: false,
      attempted: false, started: false, closing: false, cancelled: false, failed: false, commitSent: false,
    };
    active.current = gesture;
    enqueue(gesture, async () => {
      await setInteractionLock(true, owner.current);
      if (gesture.cancelled) return;
      gesture.attempted = true;
      await windowAction('resizePanel', { phase: 'start', session: gesture.id, expectedSettings: gesture.expected });
      gesture.started = true;
    });
    return gesture;
  }
  function preview(gesture: Gesture) {
    if (gesture.frame !== null || gesture.previewQueued || gesture.closing) return;
    gesture.frame = requestAnimationFrame(() => {
      gesture.frame = null;
      if (gesture.closing || gesture.failed) return;
      gesture.previewQueued = true;
      enqueue(gesture, async () => {
        const sent = { ...gesture.size };
        try { await windowAction('resizePanel', { phase: 'preview', session: gesture.id, ...sent }); }
        finally {
          gesture.previewQueued = false;
          if (!gesture.closing && (sent.width !== gesture.size.width || sent.height !== gesture.size.height)) preview(gesture);
        }
      });
    });
  }
  function changed(gesture: Gesture) { return gesture.size.width !== gesture.expected.panelWidth || gesture.size.height !== gesture.expected.panelHeight; }
  function cancel() {
    const gesture = active.current;
    if (!gesture) return;
    if (gesture.closing) { if (!gesture.commitSent) gesture.cancelled = true; return; }
    end(gesture, false);
  }
  useEffect(() => {
    alive.current = true;
    const blur = () => cancel();
    window.addEventListener('blur', blur);
    window.addEventListener('sidetask:panel-hidden', blur);
    return () => { alive.current = false; window.removeEventListener('blur', blur); window.removeEventListener('sidetask:panel-hidden', blur); cancel(); };
  }, []);
  useEffect(() => {
    if (!settings) return;
    const trail = committed.current;
    // Keep known intermediate commits until React catches up. Use the first
    // match because resizing back to an earlier size can repeat a settings value.
    const observed = trail.findIndex(value => sameSettings(settings, value));
    committed.current = observed >= 0 ? trail.slice(observed) : [];
    const gesture = active.current;
    const ownIntermediate = observed >= 0 && gesture && sameSettings(trail[trail.length - 1], gesture.expected);
    if (gesture && !gesture.closing && !sameSettings(settings, gesture.expected) && !ownIntermediate) {
      report('缩放期间设置已更新，请重新调整。');
      cancel();
    }
  }, [settings]);

  function pointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const gesture = begin('pointer', { width: bounds.width, height: bounds.height });
    if (!gesture) return;
    event.preventDefault();
    event.currentTarget.focus();
    gesture.pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, target: event.currentTarget };
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch (reason) { report(reason); cancel(); }
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const gesture = active.current;
    const pointer = gesture?.pointer;
    if (!gesture || !pointer || pointer.id !== event.pointerId || gesture.closing) return;
    const dx = event.screenX - pointer.x;
    const dy = event.screenY - pointer.y;
    if (!dx && !dy && !changed(gesture)) return;
    gesture.size = {
      width: dx === 0 ? gesture.expected.panelWidth : clamp(gesture.initial.width + dx * (gesture.expected.edge === 'right' ? -1 : 1), 300, 640),
      height: dy === 0 ? gesture.expected.panelHeight : clamp(gesture.initial.height + dy, 380, 1000),
    };
    preview(gesture);
  }
  function pointerEnd(event: PointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const gesture = active.current;
    if (!gesture || gesture.pointer?.id !== event.pointerId || gesture.closing) return;
    end(gesture, !cancelled && changed(gesture));
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && active.current) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (!arrows.includes(event.key)) return;
    event.preventDefault();
    const gesture = active.current ?? begin('keyboard');
    if (!gesture || gesture.kind !== 'keyboard' || gesture.closing) return;
    const direction = gesture.expected.edge === 'right' ? -1 : 1;
    gesture.size = {
      width: clamp(gesture.size.width + (event.key === 'ArrowRight' ? 10 * direction : event.key === 'ArrowLeft' ? -10 * direction : 0), 300, 640),
      height: clamp(gesture.size.height + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0), 380, 1000),
    };
    preview(gesture);
  }
  return {
    'aria-disabled': busy || finishing || !settings,
    'aria-busy': finishing,
    onPointerDown: pointerDown, onPointerMove: pointerMove,
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => pointerEnd(event, false),
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => pointerEnd(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => pointerEnd(event, true),
    onKeyDown: keyDown,
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      const gesture = active.current;
      if (arrows.includes(event.key) && gesture?.kind === 'keyboard' && !gesture.closing) end(gesture, changed(gesture));
    },
    onBlur: () => { if (active.current?.kind === 'keyboard') cancel(); },
  };
}
