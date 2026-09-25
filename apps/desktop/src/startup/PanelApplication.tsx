import { useEffect, useRef, useState } from 'react';
import { createPreviewResizeHandler, isDesktop } from '../lib/native';
import { useAppStore } from '../lib/store';
import EdgePanel from '../surfaces/edge-panel/EdgePanel';
import NativeApplication from './NativeApplication';
import { DraftProvider } from '../lib/drafts';
import PanelExitGuard from '../components/PanelExitGuard';

function Panel() {
  const { mutate, snapshot } = useAppStore();
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const resizeSource = useRef({ settings: snapshot?.settings, mutate });
  resizeSource.current = { settings: snapshot?.settings, mutate };
  useEffect(() => {
    if (isDesktop) return;
    const resize = createPreviewResizeHandler(
      () => resizeSource.current.settings, setPreviewSize,
      (width, height) => resizeSource.current.mutate({ type: 'updateSettings', changes: { panelWidth: width, panelHeight: height } }),
    );
    window.addEventListener('sidetask:preview-resize', resize);
    return () => window.removeEventListener('sidetask:preview-resize', resize);
  }, []);
  return <div style={{ width: previewSize?.width ?? '100%', height: previewSize?.height ?? '100%', maxWidth: '100%', maxHeight: '100%' }}><EdgePanel /></div>;
}

export default function PanelApplication() {
  return <NativeApplication><DraftProvider><PanelExitGuard><Panel /></PanelExitGuard></DraftProvider></NativeApplication>;
}
