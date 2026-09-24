import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownWideNarrow, ArrowUpRight, Check, ChevronDown, GripHorizontal, LoaderCircle, Pin, Plus, Settings2, X } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import type { Task } from '../../lib/types';
import { isPlannedToday, localDate, selectDeadlines, selectToday } from '../../lib/domain';
import { openConsole, setInteractionLock, startWindowDrag, windowAction } from '../../lib/native';
import { TaskRow } from '../../components/TaskUI';

export default function EdgePanel() {
  const { snapshot, loading, error, busy, mutate, clearError } = useAppStore();
  const [expandedCompleted, setExpandedCompleted] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; task: Task } | null>(null);
  const [split, setSplit] = useState(54);
  const [windowError, setWindowError] = useState('');
  const resize = useRef<{ x: number; y: number; width: number; height: number; edge: 'left' | 'right'; nextWidth: number; nextHeight: number } | null>(null);
  const resizeFrame = useRef<number | null>(null);
  const resizeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueSize = (width: number, height: number, commit: boolean) => {
    resizeQueue.current = resizeQueue.current.catch(() => {}).then(() => windowAction('resizePanel', { width, height, commit }));
    return resizeQueue.current;
  };
  useEffect(() => () => { if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current); if (resize.current) void resizeQueue.current.finally(() => setInteractionLock(false)).catch(() => {}); }, []);
  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !snapshot) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    resize.current = { x: event.screenX, y: event.screenY, width: bounds.width, height: bounds.height, edge: snapshot.settings.edge, nextWidth: bounds.width, nextHeight: bounds.height };
    resizeQueue.current = resizeQueue.current.catch(() => {}).then(() => setInteractionLock(true));
  }
  function updateResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = resize.current;
    if (!start) return;
    start.nextWidth = Math.round(Math.max(300, Math.min(640, start.width + (event.screenX - start.x) * (start.edge === 'right' ? -1 : 1))));
    start.nextHeight = Math.round(Math.max(380, Math.min(1000, start.height + event.screenY - start.y)));
    if (resizeFrame.current !== null) return;
    resizeFrame.current = requestAnimationFrame(() => { resizeFrame.current = null; if (resize.current) void enqueueSize(resize.current.nextWidth, resize.current.nextHeight, false).catch(reason => setWindowError(String(reason))); });
  }
  function finishResize(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = resize.current;
    if (!current) return;
    resize.current = null;
    if (resizeFrame.current !== null) { cancelAnimationFrame(resizeFrame.current); resizeFrame.current = null; }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    void perform(async () => { try { await enqueueSize(cancelled ? current.width : current.nextWidth, cancelled ? current.height : current.nextHeight, true); } finally { await setInteractionLock(false); } });
  }
  async function perform(action: () => Promise<unknown>) { try { await action(); } catch (reason) { setWindowError(reason instanceof Error ? reason.message : '操作未完成，请重试'); } }
  async function toggle(task: Task) { try { await mutate({ type: 'setCompleted', id: task.id, completed: !task.completed, expectedRevision: task.revision }); setFeedback({ message: task.completed ? '已恢复任务' : '已完成', task }); } catch { /* Shared store shows errors. */ } }
  const openTask = (task: Task) => void perform(() => openConsole('all', task.id));
  if (loading || !snapshot) return <div className="edge-panel edge-loading"><LoaderCircle className="spin" size={22}/><p>{error || '正在读取任务…'}</p></div>;
  const today = selectToday(snapshot); const active = today.filter(task => !task.completed); const completed = today.filter(task => task.completed); const deadlines = selectDeadlines(snapshot);
  const backlog = snapshot.tasks.filter(task => !task.completed && !isPlannedToday(snapshot, task.id) && snapshot.plans.some(plan => plan.taskId === task.id && plan.date < localDate()));
  const row = (task: Task, ddl = false) => <TaskRow key={task.id} task={task} compact disabled={busy} today={ddl && isPlannedToday(snapshot, task.id)} onSelect={() => openTask(task)} onToggle={() => void toggle(task)} onPlan={ddl && !isPlannedToday(snapshot, task.id) ? () => void perform(() => mutate({ type: 'planTask', id: task.id, planned: true, date: localDate() })) : undefined}/>;
  return <div className="edge-panel"><header className="edge-header"><button className="edge-drag" title="拖动小窗，调整停靠位置" aria-label="拖动小窗" onPointerDown={event => { if (event.button !== 0) return; void perform(() => startWindowDrag()); }} onPointerUp={() => void windowAction('finishDrag')}><GripHorizontal size={17}/><span>侧笺</span></button><div><button className={`icon-button ${snapshot.settings.pinned ? 'pin-active' : ''}`} title={snapshot.settings.pinned ? '取消保持展开' : '保持展开'} aria-label={snapshot.settings.pinned ? '取消保持展开' : '保持展开'} aria-pressed={snapshot.settings.pinned} onClick={() => void perform(() => mutate({ type: 'updateSettings', changes: { pinned: !snapshot.settings.pinned } }))}><Pin size={15}/></button><button className="icon-button" title="收起小窗" aria-label="收起小窗" onClick={() => void perform(async () => { if (snapshot.settings.pinned) await mutate({ type: 'updateSettings', changes: { pinned: false } }); await windowAction('hidePanel'); })}><X size={16}/></button></div></header>
    {(error || windowError) && <div className="edge-error" role="alert"><span>{error || windowError}</span><button onClick={() => { clearError(); setWindowError(''); }} aria-label="关闭错误提示"><X size={13}/></button></div>}
    <div className="edge-greeting"><span className="edge-date">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</span></div>
    <div className="edge-zones" style={{ gridTemplateRows: `minmax(76px, ${split}fr) 13px minmax(76px, ${100 - split}fr)` }}><section className="edge-zone"><div className="edge-section-heading"><div><h2>今日计划</h2><span>{active.length}</span></div><small>{completed.length} / {today.length} 已完成</small></div><div className="edge-scroll">{active.length ? active.map(task => row(task)) : <div className="edge-empty"><p>{today.length ? '今日计划已全部完成' : '今日暂无任务'}</p><span>{today.length ? '展开下方“已完成”可查看记录。' : '点击下方＋，添加今日任务。'}</span></div>}{completed.length > 0 && <><button className="edge-completed-toggle" onClick={() => setExpandedCompleted(!expandedCompleted)}><ChevronDown size={12} className={expandedCompleted ? '' : 'is-collapsed'}/>已完成 {completed.length}</button>{expandedCompleted && completed.map(task => row(task))}</>}{backlog.length > 0 && <button className="edge-backlog-link" onClick={() => void perform(() => openConsole('today'))}>此前未完成 {backlog.length}<ArrowUpRight size={12}/></button>}</div></section>
      <div className="edge-resize-divider" role="separator" aria-label="调整今日与截止日期区域的比例" aria-orientation="horizontal" aria-valuemin={30} aria-valuemax={70} aria-valuenow={Math.round(split)} tabIndex={0} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSplit(value => Math.max(30, Math.min(70, value + (event.key === 'ArrowDown' ? 5 : -5)))); } }} onPointerDown={event => { const element = event.currentTarget; element.setPointerCapture(event.pointerId); void setInteractionLock(true); }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = event.currentTarget.parentElement?.getBoundingClientRect(); if (bounds) setSplit(Math.max(30, Math.min(70, (event.clientY - bounds.top) / bounds.height * 100))); }} onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); void setInteractionLock(false); }} onPointerCancel={() => void setInteractionLock(false)}><span/></div>
      <section className="edge-zone"><div className="edge-section-heading"><div><h2>截止日期</h2><span>{deadlines.length}</span></div><button className="edge-sort" title="切换截止日期排序" aria-label={snapshot.settings.ddlSort === 'date' ? '当前按日期排序，点击按重要程度排序' : '当前按重要程度排序，点击按日期排序'} onClick={() => void perform(() => mutate({ type: 'updateSettings', changes: { ddlSort: snapshot.settings.ddlSort === 'date' ? 'priority' : 'date' } }))}><ArrowDownWideNarrow size={12}/>{snapshot.settings.ddlSort === 'date' ? '日期' : '重要程度'}</button></div><div className="edge-scroll">{deadlines.length ? deadlines.map(task => row(task, true)) : <div className="edge-empty"><p>没有待办的截止日期</p><span>为任务设置截止日期后显示在此。</span></div>}</div></section></div>
    {feedback && <div className="edge-feedback" role="status"><Check size={12}/><span>{feedback.message}</span><button onClick={() => void perform(async () => { const current = snapshot.tasks.find(task => task.id === feedback.task.id); if (current) await mutate({ type: 'setCompleted', id: current.id, completed: feedback.task.completed, expectedRevision: current.revision }); setFeedback(null); })}>撤销</button><button aria-label="关闭完成提示" onClick={() => setFeedback(null)}><X size={12}/></button></div>}
    <footer className="edge-footer"><button className="manage-button" onClick={() => void perform(() => openConsole('today'))}>管理任务</button><div><button className="icon-button" title="新建任务" aria-label="在控制台新建任务" onClick={() => void perform(() => windowAction('newTask'))}><Plus size={18}/></button><button className="icon-button" title="设置" aria-label="打开设置" onClick={() => void perform(() => openConsole('settings'))}><Settings2 size={16}/></button></div></footer>
    <button className="panel-size-grip" data-edge={snapshot.settings.edge} aria-label="调整小窗宽度和高度" title="拖动调整尺寸；方向键每次调整 10 像素" onPointerDown={beginResize} onPointerMove={updateResize} onPointerUp={event => finishResize(event)} onPointerCancel={event => finishResize(event, true)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const direction = snapshot.settings.edge === 'right' ? -1 : 1; const width = Math.max(300, Math.min(640, snapshot.settings.panelWidth + (event.key === 'ArrowRight' ? 10 * direction : event.key === 'ArrowLeft' ? -10 * direction : 0))); const height = Math.max(380, Math.min(1000, snapshot.settings.panelHeight + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0))); void perform(() => enqueueSize(width, height, true)); }}><svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m5 12 7-7m-3 7 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
  </div>;
}
