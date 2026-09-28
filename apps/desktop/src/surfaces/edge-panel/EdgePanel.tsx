import { useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { ArrowDownWideNarrow, ArrowUpRight, Check, ChevronDown, GripHorizontal, LoaderCircle, Pin, Plus, Settings2, X } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import type { Settings, Task } from '../../lib/types';
import { currentTimeZone, indexSnapshot, localDate, selectDeadlines } from '../../lib/domain';
import { openConsole, startWindowDrag, windowAction } from '../../lib/native';
import { TaskRow } from '../../components/TaskUI';
import { VirtualTaskList } from '../../components/VirtualTaskList';
import { usePanelSplit } from '../../lib/usePanelSplit';
import { usePanelResize } from '../../lib/usePanelResize';
import { QuickTodayAdd, type QuickTodayAddHandle } from './QuickTodayAdd';

export default function EdgePanel() {
  const { snapshot, loading, error, busy, mutate, clearError } = useAppStore();
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickFocus, setQuickFocus] = useState(0);
  const quickAdd = useRef<QuickTodayAddHandle>(null);
  const quickButton = useRef<HTMLButtonElement>(null);
  function openQuickAdd() { setQuickAddOpen(true); setQuickFocus(value => value + 1); }
  function closeQuickAdd() { setQuickAddOpen(false); quickButton.current?.focus(); }
  function navigate(action: () => Promise<unknown>) {
    const go = () => { void perform(action); };
    if (quickAdd.current) quickAdd.current.leave(go); else go();
  }
  const [expandedCompleted, setExpandedCompleted] = useState(false);
  const todayScroll = useRef<HTMLDivElement>(null);
  const deadlineScroll = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<{ message: string; task: Task; removedDate?: string } | null>(null);
  const [windowError, setWindowError] = useState('');
  const titleDrag = useRef<{ id: number; start?: Promise<boolean> } | null>(null);
  const split = usePanelSplit(snapshot?.settings.panelSplit ?? 54, busy, async value => {
    await mutate({ type: 'updateSettings', changes: { panelSplit: value } });
  }, setWindowError);
  const day = localDate();
  const zone = currentTimeZone();
  const view = useMemo(() => snapshot ? indexSnapshot(snapshot, day) : null, [snapshot, day]);
  const deadlines = useMemo(() => snapshot ? selectDeadlines(snapshot, zone) : [], [snapshot, zone]);
  const resizeProps = usePanelResize(snapshot?.settings, busy, setWindowError);
  async function perform(action: () => Promise<unknown>) { try { await action(); } catch (reason) { setWindowError(reason instanceof Error ? reason.message : '操作未完成，请重试'); } }
  function focusKeyboardControl(event: PointerEvent<HTMLElement>) {
    if (event.button === 0 && event.isPrimary && event.currentTarget.getAttribute('aria-disabled') !== 'true') void perform(() => windowAction('focusPanel'));
  }
  function titlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || titleDrag.current) return;
    const current: { id: number; start?: Promise<boolean> } = { id: event.pointerId };
    titleDrag.current = current;
    try { event.currentTarget.setPointerCapture(event.pointerId); }
    catch (reason) { titleDrag.current = null; setWindowError(String(reason)); return; }
    // Tao/AppKit expects the mouse-down event to begin its system drag loop.
    // The native completion path treats a click/small jitter as zero-write.
    current.start = startWindowDrag().then(() => true, reason => {
      setWindowError(reason instanceof Error ? reason.message : '移动未完成，请重试');
      return false;
    });
  }
  function titlePointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const current = titleDrag.current;
    if (!current || current.id !== event.pointerId) return;
    titleDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // Starting native dragging can itself release WebView capture. The backend
    // checks the real button state; serialize completion after its start request.
    if (current.start) void perform(async () => { if (await current.start) await windowAction('finishDrag'); });
  }
  async function toggle(task: Task) { try { await mutate({ type: 'setCompleted', id: task.id, completed: !task.completed, expectedRevision: task.revision }); setFeedback({ message: task.completed ? '已恢复任务' : '已完成', task }); } catch { /* Shared store shows errors. */ } }
  async function removeToday(task: Task) {
    const date = localDate();
    try { await mutate({ type: 'planTask', id: task.id, planned: false, date }); setFeedback({ message: '已移出今日，任务仍保留', task, removedDate: date }); }
    catch { /* Shared store keeps the committed plan and exposes errors. */ }
  }
  const openTask = (task: Task) => navigate(() => openConsole('all', task.id));
  if (loading || !snapshot || !view) return <div className="edge-panel edge-loading"><LoaderCircle className="spin" size={22}/><p>{error || '正在读取任务…'}</p></div>;
  const { today, activeToday: active, completedToday: completed, earlier: backlog } = view;
  const reorder = (scope: 'today' | 'deadlines') => ({
    revision: snapshot.revision, context: scope === 'today' ? 'today:' + day : scope, disabled: busy,
    title: (task: Task) => task.title, protectPanel: true,
    prepare: () => windowAction('focusPanel'),
    commit: (taskIds: string[], expectedRevision: number) => mutate(scope === 'today'
      ? { type: 'reorderToday', date: day, taskIds }
      : { type: 'reorderTasks', scope: 'deadlines', taskIds }, expectedRevision),
  });
  const row = (task: Task, ddl = false) => <TaskRow key={task.id} task={task} compact disabled={busy} today={ddl && view.todayIds.has(task.id)} onSelect={() => openTask(task)} onToggle={() => void toggle(task)} onPlan={ddl && !view.todayIds.has(task.id) ? () => void perform(() => mutate({ type: 'planTask', id: task.id, planned: true, date: localDate() })) : undefined} onRemoveToday={!ddl && !task.completed ? () => void removeToday(task) : undefined}/>;
  return <div className="edge-panel"><header className="edge-header"><button className="edge-drag" title="拖动小窗，调整停靠位置" aria-label="拖动小窗" onPointerDown={titlePointerDown} onPointerUp={titlePointerEnd} onPointerCancel={titlePointerEnd} onLostPointerCapture={titlePointerEnd}><GripHorizontal size={17}/><span>侧笺</span></button><div><button className={`icon-button ${snapshot.settings.pinned ? 'pin-active' : ''}`} title={snapshot.settings.pinned ? '取消保持展开' : '保持展开'} aria-label={snapshot.settings.pinned ? '取消保持展开' : '保持展开'} aria-pressed={snapshot.settings.pinned} onClick={() => void perform(() => mutate({ type: 'updateSettings', changes: { pinned: !snapshot.settings.pinned } }))}><Pin size={15}/></button><button className="icon-button" title="收起小窗" aria-label="收起小窗" onClick={() => void perform(async () => { if (snapshot.settings.pinned) await mutate({ type: 'updateSettings', changes: { pinned: false } }); await windowAction('hidePanel'); })}><X size={16}/></button></div></header>
    {(error || windowError) && <div className="edge-error" role="alert"><span>{error || windowError}</span><button onClick={() => { clearError(); setWindowError(''); }} aria-label="关闭错误提示"><X size={13}/></button></div>}
    {split.failure && <div className="edge-split-error" role="alert"><span>{split.failure === 'conflict' ? '分区比例已在另一处改变，你的调整尚未保存。' : '分区比例未保存，请重试。'}</span><div><button disabled={busy || split.saving} onClick={split.retry}>{split.failure === 'conflict' ? '使用此比例' : '重试保存'}</button><button disabled={busy || split.saving} onClick={split.discard}>恢复已保存比例</button></div></div>}
    <div className="edge-greeting"><span className="edge-date">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</span></div>
    <div className="edge-zones" style={{ gridTemplateRows: `minmax(76px, ${split.value}fr) 13px minmax(76px, ${100 - split.value}fr)` }}><section className="edge-zone"><div className="edge-section-heading"><div><h2>今日计划</h2><span>{active.length}</span><button ref={quickButton} className="icon-button edge-today-add" title="添加今日任务" aria-label="添加今日任务" aria-expanded={quickAddOpen} aria-controls="quick-today-add" onClick={openQuickAdd}><Plus size={15}/></button></div><small>{completed.length} / {today.length} 已完成</small></div><div ref={todayScroll} className="edge-scroll"><QuickTodayAdd ref={quickAdd} open={quickAddOpen} focusRequest={quickFocus} onClose={closeQuickAdd}/>{active.length ? <VirtualTaskList items={active} reorder={reorder('today')} renderItem={task => row(task)} scrollRef={todayScroll} estimateSize={64} label="今日未完成任务" /> : <div className="edge-empty"><p>{today.length ? '今日计划已全部完成' : '今日暂无任务'}</p><span>{today.length ? '展开下方“已完成”可查看记录。' : '点击“今日计划”旁的＋，添加任务。'}</span></div>}{completed.length > 0 && <><button className="edge-completed-toggle" onClick={() => setExpandedCompleted(!expandedCompleted)}><ChevronDown size={12} className={expandedCompleted ? '' : 'is-collapsed'}/>已完成 {completed.length}</button>{expandedCompleted && <VirtualTaskList items={completed} renderItem={task => row(task)} scrollRef={todayScroll} estimateSize={64} label="今日已完成任务" />}</>}{backlog.length > 0 && <button className="edge-backlog-link" onClick={() => navigate(() => openConsole('today'))}>此前未完成 {backlog.length}<ArrowUpRight size={12}/></button>}</div></section>
      <div className="edge-resize-divider" title="拖动调整两区比例，松手后保存；方向键每次调整 5%" role="separator" aria-label="调整今日与截止日期区域的比例" aria-orientation="horizontal" aria-valuemin={30} aria-valuemax={70} aria-valuenow={split.value} aria-valuetext={`今日 ${split.value}%，截止日期 ${100 - split.value}%${split.saving ? '，正在保存' : ''}`} tabIndex={0} onPointerDownCapture={focusKeyboardControl} {...split.dividerProps}><span/></div>
      <section className="edge-zone"><div className="edge-section-heading"><div><h2>截止日期</h2><span>{deadlines.length}</span></div><label className="edge-sort"><ArrowDownWideNarrow size={12}/><select aria-label="截止任务排序" disabled={busy} value={snapshot.settings.ddlSort} onPointerDownCapture={focusKeyboardControl} onChange={event => void perform(() => mutate({ type: 'updateSettings', changes: { ddlSort: event.target.value as Settings['ddlSort'] } }))}><option value="date">按截止日期</option><option value="priority">按重要程度</option><option value="manual">手动排序</option></select></label></div><div ref={deadlineScroll} className="edge-scroll">{deadlines.length ? <VirtualTaskList items={deadlines} reorder={reorder('deadlines')} renderItem={task => row(task, true)} scrollRef={deadlineScroll} estimateSize={64} resetKey={snapshot.settings.ddlSort} label="截止日期任务" /> : <div className="edge-empty"><p>没有待办的截止日期</p><span>为任务设置截止日期后显示在此。</span></div>}</div></section></div>
    {feedback && <div className="edge-feedback" role="status"><Check size={12}/><span>{feedback.message}</span><button onClick={() => void perform(async () => { const current = view.byId.get(feedback.task.id); if (current) { if (feedback.removedDate) await mutate({ type: 'planTask', id: current.id, planned: true, date: feedback.removedDate }); else await mutate({ type: 'setCompleted', id: current.id, completed: feedback.task.completed, expectedRevision: current.revision }); } setFeedback(null); })}>{feedback.removedDate ? '重新加入' : '撤销'}</button><button aria-label="关闭完成提示" onClick={() => setFeedback(null)}><X size={12}/></button></div>}
    <footer className="edge-footer"><button className="manage-button" onClick={() => navigate(() => openConsole('today'))}>管理任务</button><div><button className="icon-button" title="快速添加今日任务" aria-label="快速添加今日任务" aria-expanded={quickAddOpen} aria-controls="quick-today-add" onClick={openQuickAdd}><Plus size={18}/></button><button className="icon-button" title="设置" aria-label="打开设置" onClick={() => navigate(() => openConsole('settings'))}><Settings2 size={16}/></button></div></footer>
    <button className="panel-size-grip" data-edge={snapshot.settings.edge} aria-label="调整小窗宽度和高度" title="拖动调整尺寸；方向键每次调整 10 逻辑像素，松开保存，Esc 取消" onPointerDownCapture={focusKeyboardControl} {...resizeProps}><svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m5 12 7-7m-3 7 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
  </div>;
}
