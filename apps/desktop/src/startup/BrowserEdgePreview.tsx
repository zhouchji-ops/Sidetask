import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../lib/store';
import { createPreviewResizeHandler } from '../lib/native';
import EdgePanel from '../surfaces/edge-panel/EdgePanel';
import EdgeHandle from '../surfaces/edge-panel/EdgeHandle';

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
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function hover(enter: boolean) {
    inside.current = enter;
    clearTimeout(hoverTimer.current);
    if (snapshot?.settings.revealMode !== 'hover') return;
    hoverTimer.current = setTimeout(() => {
      if (dragging || locked.current || (!enter && snapshot.settings.pinned)) return;
      setVisible(enter);
    }, enter ? snapshot.settings.revealDelay : snapshot.settings.hideDelay);
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), [snapshot?.settings.revealMode, snapshot?.settings.pinned, dragging]);
  useEffect(() => { if (snapshot) setSide(snapshot.settings.edge); }, [snapshot?.settings.edge]);
  useEffect(() => { setSize(null); }, [snapshot?.settings.panelWidth, snapshot?.settings.panelHeight]);
  useEffect(() => { if (snapshot?.settings.pinned) setVisible(true); }, [snapshot?.settings.pinned]);
  useEffect(() => {
    const preview = (event: Event) => setVisible(Boolean((event as CustomEvent).detail.visible));
    const leave = () => { if (snapshot?.settings.revealMode === 'hover' && !snapshot.settings.pinned && !inside.current && !dragging && !locked.current) setVisible(false); };
    const outside = (event: PointerEvent) => {
      if (snapshot?.settings.revealMode === 'click' && visible && !snapshot.settings.pinned && !dragging && !locked.current && !previewElement.current?.contains(event.target as Node)) setVisible(false);
    };
    const interaction = (event: Event) => { locked.current = Boolean((event as CustomEvent).detail.locked); };
    const begin = () => setDragging(true);
    const move = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      // Replacing the handle with a panel can omit a paired pointerleave.
      // The stable wrapper's actual bounds recover that signal on movement.
      const bounds = previewElement.current?.getBoundingClientRect();
      const wasInside = inside.current;
      inside.current = !!bounds && event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom;
      if (wasInside && !inside.current) hover(false);
      if (dragging) {
        setOffset(Math.max(12, Math.min(window.innerHeight - (visible ? 450 : 100), event.clientY - 24)));
        setSide(event.clientX < window.innerWidth / 2 ? 'left' : 'right');
      }
    };
    const end = () => {
      if (!dragging) return;
      setDragging(false);
      const edge = lastPointer.current.x < window.innerWidth / 2 ? 'left' : 'right';
      setSide(edge);
      void mutate({ type: 'updateSettings', changes: { edge } }).catch(() => {});
    };
    window.addEventListener('sidetask:preview', preview);
    window.addEventListener('sidetask:preview-leave', leave);
    window.addEventListener('sidetask:preview-interaction', interaction);
    window.addEventListener('sidetask:drag-start', begin);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('sidetask:preview', preview);
      window.removeEventListener('sidetask:preview-leave', leave);
      window.removeEventListener('sidetask:preview-interaction', interaction);
      window.removeEventListener('sidetask:drag-start', begin);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [snapshot?.settings.pinned, snapshot?.settings.revealMode, snapshot?.settings.revealDelay, snapshot?.settings.hideDelay, dragging, visible, mutate]);
  if (!snapshot || (!snapshot.settings.edgeEnabled && !visible)) return null;
  const width = Math.min(size?.width ?? snapshot.settings.panelWidth, window.innerWidth - 24);
  const height = Math.min(size?.height ?? snapshot.settings.panelHeight, window.innerHeight - 24);
  return <div
    ref={previewElement}
    className={`browser-edge-preview ${visible ? 'is-expanded' : ''}`}
    data-testid="browser-edge-preview"
    onPointerEnter={() => hover(true)}
    onPointerLeave={() => hover(false)}
    style={{ position: 'fixed', zIndex: 100, [side]: 8, top: Math.min(offset, window.innerHeight - (visible ? height : 100) - 12), width: visible ? width : 20, height: visible ? height : 96, filter: visible ? 'drop-shadow(0 10px 28px #172e2526)' : undefined }}
  >{visible ? <EdgePanel /> : <EdgeHandle />}</div>;
}
