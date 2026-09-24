import { useRef } from 'react';
import { startWindowDrag, windowAction } from '../../lib/native';
export default function EdgeHandle() {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  return <button className="edge-handle" aria-label="展开侧笺；按住拖动可调整位置" title="侧笺 · 悬停查看，拖动移动" onPointerDown={event => { if (event.button !== 0) return; origin.current = { x: event.clientX, y: event.clientY }; dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!origin.current || dragged.current) return; if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) >= 5) { dragged.current = true; void startWindowDrag(); } }} onPointerUp={() => { origin.current = null; if (dragged.current) void windowAction('finishDrag'); }} onPointerCancel={() => { origin.current = null; void windowAction('finishDrag'); }} onClick={() => { if (!dragged.current) void windowAction('showPanel'); dragged.current = false; }}><span/><span/><span/></button>;
}
