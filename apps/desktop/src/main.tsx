import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppStoreProvider, useAppStore } from './lib/store';
import { attachNativeNavigation, isDesktop, windowAction } from './lib/native';
import Console from './surfaces/console/Console';
import EdgePanel from './surfaces/edge-panel/EdgePanel';
import EdgeHandle from './surfaces/edge-panel/EdgeHandle';
import { StartupGate } from './surfaces/recovery/Recovery';
import './styles/app.css';
import './styles/variants.css';
import './styles/style-picker.css';

const surface = new URLSearchParams(location.search).get('surface') || 'console';
document.documentElement.dataset.surface = surface;
document.documentElement.dataset.runtime = isDesktop ? 'desktop' : 'browser';

function BrowserEdgePreview() {
  const { snapshot, mutate } = useAppStore();
  const [visible, setVisible] = useState(false);
  const [offset, setOffset] = useState(120);
  const [dragging, setDragging] = useState(false);
  const [side, setSide] = useState<'left' | 'right'>('right');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const previewElement = useRef<HTMLDivElement>(null);
  const lastPointer = useRef({ x: 0, y: 120 });
  const inside = useRef(false);
  const locked = useRef(false);
  useEffect(() => { if (snapshot) setSide(snapshot.settings.edge); }, [snapshot?.settings.edge]);
  useEffect(() => { setSize(null); }, [snapshot?.settings.panelWidth, snapshot?.settings.panelHeight]);
  useEffect(() => { if (snapshot?.settings.pinned) setVisible(true); }, [snapshot?.settings.pinned]);
  useEffect(() => {
    const preview = (event: Event) => setVisible(Boolean((event as CustomEvent).detail.visible));
    const leave = () => { if (!snapshot?.settings.pinned && !inside.current && !dragging && !locked.current) setVisible(false); };
    const interaction = (event: Event) => { locked.current = Boolean((event as CustomEvent).detail.locked); };
    const resize = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const width = Math.max(300, Math.min(640, Math.round(Number(detail.width))));
      const height = Math.max(380, Math.min(1000, Math.round(Number(detail.height))));
      if (!Number.isFinite(width) || !Number.isFinite(height)) { detail.reject(new Error('窗口尺寸无效')); return; }
      setSize({ width, height });
      if (detail.commit === false) detail.resolve();
      else void mutate({ type: 'updateSettings', changes: { panelWidth: width, panelHeight: height } }).then(detail.resolve).catch((error) => { setSize(null); detail.reject(error); });
    };
    const begin = () => setDragging(true);
    const move = (event: PointerEvent) => {
      lastPointer.current = { x: event.clientX, y: event.clientY };
      // Replacing the handle with a panel can omit a paired pointerleave.
      // The stable wrapper's actual bounds recover that signal on movement.
      const bounds = previewElement.current?.getBoundingClientRect();
      const wasInside = inside.current;
      inside.current = !!bounds && event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom;
      if (wasInside && !inside.current) void windowAction('hoverLeave');
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
    window.addEventListener('sidetask:preview-resize', resize);
    window.addEventListener('sidetask:drag-start', begin);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('sidetask:preview', preview);
      window.removeEventListener('sidetask:preview-leave', leave);
      window.removeEventListener('sidetask:preview-interaction', interaction);
      window.removeEventListener('sidetask:preview-resize', resize);
      window.removeEventListener('sidetask:drag-start', begin);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [snapshot?.settings.pinned, dragging, visible, mutate]);
  if (!snapshot || (!snapshot.settings.edgeEnabled && !visible)) return null;
  const width = Math.min(size?.width ?? snapshot.settings.panelWidth, window.innerWidth - 24);
  const height = Math.min(size?.height ?? snapshot.settings.panelHeight, window.innerHeight - 24);
  return <div
    ref={previewElement}
    className={`browser-edge-preview ${visible ? 'is-expanded' : ''}`}
    data-testid="browser-edge-preview"
    onPointerEnter={() => { inside.current = true; void windowAction('hoverEnter'); }}
    onPointerLeave={() => { inside.current = false; void windowAction('hoverLeave'); }}
    style={{ position: 'fixed', zIndex: 100, [side]: 8, top: Math.min(offset, window.innerHeight - (visible ? height : 100) - 12), width: visible ? width : 20, height: visible ? height : 96, filter: visible ? 'drop-shadow(0 10px 28px #172e2526)' : undefined }}
  >{visible ? <EdgePanel /> : <EdgeHandle />}</div>;
}
function App() {
  const { mutate } = useAppStore();
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (isDesktop || surface !== 'edge-panel') return;
    const resize = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const width = Math.max(300, Math.min(640, Math.round(Number(detail.width))));
      const height = Math.max(380, Math.min(1000, Math.round(Number(detail.height))));
      if (!Number.isFinite(width) || !Number.isFinite(height)) { detail.reject(new Error('窗口尺寸无效')); return; }
      setPreviewSize({ width, height });
      if (detail.commit === false) detail.resolve();
      else void mutate({ type: 'updateSettings', changes: { panelWidth: width, panelHeight: height } }).then(detail.resolve).catch(detail.reject);
    };
    window.addEventListener('sidetask:preview-resize', resize);
    return () => window.removeEventListener('sidetask:preview-resize', resize);
  }, [mutate]);
  useEffect(() => {
    let done = false;
    let cleanup: (() => void) | undefined;
    void attachNativeNavigation().then(stop => { if (done) stop(); else cleanup = stop; });
    return () => { done = true; cleanup?.(); };
  }, []);
  if (surface === 'edge-handle') return <EdgeHandle />;
  if (surface === 'edge-panel') return <div style={{ width: previewSize?.width ?? '100%', height: previewSize?.height ?? '100%', maxWidth: '100%', maxHeight: '100%' }}><EdgePanel /></div>;
  return <><Console />{!isDesktop && <BrowserEdgePreview />}</>;
}
const application = <AppStoreProvider><App /></AppStoreProvider>;
createRoot(document.getElementById('root')!).render(<React.StrictMode>{isDesktop && surface === 'console' ? <StartupGate>{application}</StartupGate> : application}</React.StrictMode>);
