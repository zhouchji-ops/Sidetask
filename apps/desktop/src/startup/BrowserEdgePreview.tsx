import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/store';
import { createPreviewResizeHandler, windowAction } from '../lib/native';
import EdgePanel from '../surfaces/edge-panel/EdgePanel';
import EdgeHandle from '../surfaces/edge-panel/EdgeHandle';
import { DraftProvider } from '../lib/drafts';
import PanelExitGuard from '../components/PanelExitGuard';

export default function BrowserEdgePreview() {
  const { snapshot, mutate } = useAppStore();
  const [visible, setVisible] = useState(false);
  const [offset, setOffset] = useState(120);
  const [dragging, setDragging] = useState(false);
  const [side, setSide] = useState<'left' | 'right'>('right');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const resizeSource = useRef({ settings: snapshot?.settings, mutate });
  resizeSource.current = { settings: snapshot?.settings, mutate };
  useEffect(() => {
    const resize = createPreviewResizeHandler(
      () => resizeSource.current.settings, setSize,
      (width, height) => resizeSource.current.mutate({ type: 'updateSettings', changes: { panelWidth: width, panelHeight: height } }),
    );
    window.addEventListener('sidetask:preview-resize', resize);
    return () => window.removeEventListener('sidetask:preview-resize', resize);
  }, []);
  const previewElement = useRef<HTMLDivElement>(null);
  const lastPointer = useRef({ x: 0, y: 120 });
  const inside = useRef(false);
  const locked = useRef(false);
  const pointerHeld = useRef(false);
  const gestureActive = useRef(false);
  const suppressed = useRef(false);
  useEffect(() => { if (snapshot) setSide(snapshot.settings.edge); }, [snapshot?.settings.edge]);
  useEffect(() => { setSize(null); }, [snapshot?.settings.panelWidth, snapshot?.settings.panelHeight]);
  useEffect(() => { if (snapshot?.settings.pinned) setVisible(true); }, [snapshot?.settings.pinned]);
  useEffect(() => {
    const settings = snapshot?.settings;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => { clearTimeout(revealTimer); clearTimeout(hideTimer); };
    const hide = () => { suppressed.current = true; clearTimers(); window.dispatchEvent(new Event('sidetask:panel-hidden')); setVisible(false); };
    const preview = (event: Event) => { clearTimers(); if ((event as CustomEvent).detail.visible) setVisible(true); else hide(); };
    const hover = () => {
      clearTimers();
      if (!inside.current) suppressed.current = false;
      if (settings?.revealMode !== 'hover' || !settings.edgeEnabled || gestureActive.current) return;
      if (inside.current && !visible && !suppressed.current) revealTimer = setTimeout(() => {
        if (inside.current && !gestureActive.current) setVisible(true);
      }, settings.revealDelay);
      else if (!inside.current && visible && !settings.pinned && !locked.current) hideTimer = setTimeout(() => {
        if (!inside.current && !locked.current && !gestureActive.current) hide();
      }, settings.hideDelay);
    };
    const hoverEvent = (event: Event) => { inside.current = Boolean((event as CustomEvent).detail.inside); hover(); };
    const interaction = (event: Event) => { locked.current = Boolean((event as CustomEvent).detail.locked); hover(); };
    const begin = () => { suppressed.current = true; gestureActive.current = true; clearTimers(); setDragging(true); };
    const pointerDown = (event: PointerEvent) => {
      const element = previewElement.current;
      if (event.target instanceof Node && element?.contains(event.target)) { pointerHeld.current = true; return; }
      // This observes the click without cancelling it. Drafts stay mounted;
      // only pointer gestures and an active quit confirmation prevent dismissal.
      if (visible && settings?.revealMode === 'click' && !settings.pinned && !gestureActive.current && !pointerHeld.current && !element?.querySelector('.panel-exit-surface[inert]')) hide();
    };
    const move = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      // Replacing the handle with a panel can omit a paired pointerleave.
      // The stable wrapper's actual bounds recover that signal on movement.
      const bounds = previewElement.current?.getBoundingClientRect();
      const wasInside = inside.current;
      inside.current = !!bounds && event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom;
      if (wasInside !== inside.current) hover();
      if (dragging) {
        setOffset(Math.max(12, Math.min(window.innerHeight - (visible ? 450 : 100), event.clientY - 24)));
        setSide(event.clientX < window.innerWidth / 2 ? 'left' : 'right');
      }
    };
    const end = () => {
      pointerHeld.current = false;
      gestureActive.current = false;
      if (!dragging) return;
      setDragging(false);
      const edge = lastPointer.current.x < window.innerWidth / 2 ? 'left' : 'right';
      setSide(edge);
      void mutate({ type: 'updateSettings', changes: { edge } }).catch(() => {});
    };
    window.addEventListener('sidetask:preview', preview);
    window.addEventListener('sidetask:preview-hover', hoverEvent);
    window.addEventListener('sidetask:preview-interaction', interaction);
    window.addEventListener('sidetask:drag-start', begin);
    window.addEventListener('pointermove', move);
    document.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // Committed mode/delay/pin changes cancel stale timers and evaluate the
    // current pointer again, even when it has not crossed another boundary.
    hover();
    return () => {
      clearTimers();
      window.removeEventListener('sidetask:preview', preview);
      window.removeEventListener('sidetask:preview-hover', hoverEvent);
      window.removeEventListener('sidetask:preview-interaction', interaction);
      window.removeEventListener('sidetask:drag-start', begin);
      window.removeEventListener('pointermove', move);
      document.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [snapshot?.settings.pinned, snapshot?.settings.revealMode, snapshot?.settings.revealDelay, snapshot?.settings.hideDelay, snapshot?.settings.edgeEnabled, dragging, visible, mutate]);
  if (!snapshot) return null;
  const width = Math.min(size?.width ?? snapshot.settings.panelWidth, window.innerWidth - 24);
  const height = Math.min(size?.height ?? snapshot.settings.panelHeight, window.innerHeight - 24);
  return <div
    ref={previewElement}
    className={`browser-edge-preview ${visible ? 'is-expanded' : ''}`}
    data-testid="browser-edge-preview"
    hidden={!snapshot.settings.edgeEnabled && !visible}
    onPointerEnter={() => { inside.current = true; void windowAction('hoverEnter'); }}
    onPointerLeave={() => { inside.current = false; void windowAction('hoverLeave'); }}
    style={{ position: 'fixed', zIndex: 100, [side]: 8, top: Math.min(offset, window.innerHeight - (visible ? height : 100) - 12), width: visible ? width : 20, height: visible ? height : 96, filter: visible ? 'drop-shadow(0 10px 28px #172e2526)' : undefined }}
  ><div hidden={!visible} style={{ width: '100%', height: '100%' }}><DraftProvider><PanelExitGuard><EdgePanel /></PanelExitGuard></DraftProvider></div>{!visible && <EdgeHandle />}</div>;
}
