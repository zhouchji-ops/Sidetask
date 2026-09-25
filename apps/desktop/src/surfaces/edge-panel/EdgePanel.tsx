import { useMemo, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowUpRight, Check, ChevronDown, GripHorizontal, LoaderCircle, Pin, Plus, Settings2, X } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import type { Task } from '../../lib/types';
import { currentTimeZone, indexSnapshot, localDate, selectDeadlines } from '../../lib/domain';
import { openConsole, startWindowDrag, windowAction } from '../../lib/native';
import { TaskRow } from '../../components/TaskUI';
import { VirtualTaskList } from '../../components/VirtualTaskList';
import { usePanelSplit } from '../../lib/usePanelSplit';
import { usePanelResize } from '../../lib/usePanelResize';
import { useQuickAddToday } from './useQuickAddToday';

export default function EdgePanel() {
  const { snapshot, loading, error, busy, mutate, clearError } = useAppStore();
  const quickAdd = useQuickAddToday(mutate, busy);
  const [expandedCompleted, setExpandedCompleted] = useState(false);
  const todayScroll = useRef<HTMLDivElement>(null);
  const deadlineScroll = useRef<HTMLDivElement>(null);
  const [feedback, setFeedback] = useState<{ message: string; task: Task; removedDate?: string } | null>(null);
  const [windowError, setWindowError] = useState('');
  const split = usePanelSplit(snapshot?.settings.panelSplit ?? 54, busy, async value => {
    await mutate({ type: 'updateSettings', changes: { panelSplit: value } });
  }, setWindowError);
  const day = localDate();
  const zone = currentTimeZone();
  const view = useMemo(() => snapshot ? indexSnapshot(snapshot, day) : null, [snapshot, day]);
  const deadlines = useMemo(() => snapshot ? selectDeadlines(snapshot, zone) : [], [snapshot, zone]);
  const resizeProps = usePanelResize(snapshot?.settings, busy, setWindowError);
  async function perform(action: () => Promise<unknown>) { try { await action(); } catch (reason) { setWindowError(reason instanceof Error ? reason.message : '操作未完成，请重试'); } }
  async function toggle(task: Task) { try { await mutate({ type: 'setCompleted', id: task.id, completed: !task.completed, expectedRevision: task.revision }); setFeedback({ message: task.completed ? '已恢复任务' : '已完成', task }); } catch { /* Shared store shows errors. */ } }
  async function removeToday(task: Task) {
    const date = localDate();
    try { await mutate({ type: 'planTask', id: task.id, planned: false, date }); setFeedback({ message: '已移出今日，任务仍保留', task, removedDate: date }); }
    catch { /* Shared store keeps the committed plan and exposes errors. */ }
  }
  const openTask = (task: Task) => void perform(() => openConsole('all', task.id));
  if (loading || !snapshot || !view) return <div className="edge-panel edge-loading"><LoaderCircle className="spin" size={22}/><p>{error || '正在读取任务…'}</p></div>;
  const { today, activeToday: active, completedToday: completed, earlier: backlog } = view;
  const row = (task: Task, ddl = false) => <TaskRow key={task.id} task={task} compact disabled={busy} today={ddl && view.todayIds.has(task.id)} onSelect={() => openTask(task)} onToggle={() => void toggle(task)} onPlan={ddl && !view.todayIds.has(task.id) ? () => void perform(() => mutate({ type: 'planTask', id: task.id, planned: true, date: localDate() })) : undefined} onRemoveToday={!ddl && !task.completed ? () => void removeToday(task) : undefined}/>;
  return <div className="edge-panel"><header className="edge-header"><button className="edge-drag" title="拖动小窗，调整停靠位置" aria-label="拖动小窗" onPointerDown={event => { if (event.button !== 0) return; void perform(() => startWindowDrag()); }} onPointerUp={() => void windowAction('finishDrag')}><GripHorizontal size={17}/><span>侧笺</span></button><div><button className={`icon-button ${snapshot.settings.pinned ? 'pin-active' : ''}`} title={snapshot.settings.pinned ? '取消保持展开' : '保持展开'} aria-label={snapshot.settings.pinned ? '取消保持展开' : '保持展开'} aria-pressed={snapshot.settings.pinned} onClick={() => void perform(() => mutate({ type: 'updateSettings', changes: { pinned: !snapshot.settings.pinned } }))}><Pin size={15}/></button><button className="icon-button" title="收起小窗" aria-label="收起小窗" onClick={() => { const hide = () => void perform(async () => { if (snapshot.settings.pinned) await mutate({ type: 'updateSettings', changes: { pinned: false } }); await windowAction('hidePanel'); }); if (quickAdd.open) quickAdd.requestClose(hide); else hide(); }}><X size={16}/></button></div></header>
    {(error || windowError) && <div className="edge-error" role="alert"><span>{error || windowError}</span><button onClick={() => { clearError(); setWindowError(''); }} aria-label="关闭错误提示"><X size={13}/></button></div>}
    {split.failure && <div className="edge-split-error" role="alert"><span>{split.failure === 'conflict' ? '分区比例已在另一处改变，你的调整尚未保存。' : '分区比例未保存，请重试。'}</span><div><button disabled={busy || split.saving} onClick={split.retry}>{split.failure === 'conflict' ? '使用此比例' : '重试保存'}</button><button disabled={busy || split.saving} onClick={split.discard}>恢复已保存比例</button></div></div>}
    <div className="edge-greeting"><span className="edge-date">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</span></div>
    <div className="edge-zones" style={{ gridTemplateRows: `minmax(76px, ${split.value}fr) 13px minmax(76px, ${100 - split.value}fr)` }}><section className="edge-zone"><div className="edge-section-heading"><div><h2>今日计划</h2><span>{active.length}</span><button ref={quickAdd.trigger} className="icon-button quick-add-trigger" title="添加今日任务" aria-label="添加今日任务" aria-expanded={quickAdd.open} aria-controls="edge-quick-add" disabled={quickAdd.working || busy} onClick={() => void quickAdd.activate()}><Plus size={15}/></button></div><small>{completed.length} / {today.length} 已完成</small></div><div ref={todayScroll} className="edge-scroll">{quickAdd.editor}{active.length ? <VirtualTaskList items={active} renderItem={task => row(task)} scrollRef={todayScroll} estimateSize={64} label="今日未完成任务" /> : <div className="edge-empty"><p>{today.length ? '今日计划已全部完成' : '今日暂无任务'}</p><span>{today.length ? '展开下方“已完成”可查看记录。' : '点击“今日计划”旁的＋，直接添加任务。'}</span></div>}{completed.length > 0 && <><button className="edge-completed-toggle" onClick={() => setExpandedCompleted(!expandedCompleted)}><ChevronDown size={12} className={expandedCompleted ? '' : 'is-collapsed'}/>已完成 {completed.length}</button>{expandedCompleted && <VirtualTaskList items={completed} renderItem={task => row(task)} scrollRef={todayScroll} estimateSize={64} label="今日已完成任务" />}</>}{backlog.length > 0 && <button className="edge-backlog-link" onClick={() => void perform(() => openConsole('today'))}>此前未完成 {backlog.length}<ArrowUpRight size={12}/></button>}</div></section>
      <div className="edge-resize-divider" title="拖动调整两区比例，松手后保存；方向键每次调整 5%" role="separator" aria-label="调整今日与截止日期区域的比例" aria-orientation="horizontal" aria-valuemin={30} aria-valuemax={70} aria-valuenow={split.value} aria-valuetext={`今日 ${split.value}%，截止日期 ${100 - split.value}%${split.saving ? '，正在保存' : ''}`} tabIndex={0} {...split.dividerProps}><span/></div>
      <section className="edge-zone"><div className="edge-section-heading"><div><h2>截止日期</h2><span>{deadlines.length}</span></div><button className="edge-sort" title="切换截止日期排序" aria-label={snapshot.settings.ddlSort === 'date' ? '当前按日期排序，点击按重要程度排序' : '当前按重要程度排序，点击按日期排序'} onClick={() => void perform(() => mutate({ type: 'updateSettings', changes: { ddlSort: snapshot.settings.ddlSort === 'date' ? 'priority' : 'date' } }))}><ArrowDownWideNarrow size={12}/>{snapshot.settings.ddlSort === 'date' ? '日期' : '重要程度'}</button></div><div ref={deadlineScroll} className="edge-scroll">{deadlines.length ? <VirtualTaskList items={deadlines} renderItem={task => row(task, true)} scrollRef={deadlineScroll} estimateSize={64} resetKey={snapshot.settings.ddlSort} label="截止日期任务" /> : <div className="edge-empty"><p>没有待办的截止日期</p><span>为任务设置截止日期后显示在此。</span></div>}</div></section></div>
    {feedback && <div className="edge-feedback" role="status"><Check size={12}/><span>{feedback.message}</span><button onClick={() => void perform(async () => { const current = view.byId.get(feedback.task.id); if (current) { if (feedback.removedDate) await mutate({ type: 'planTask', id: current.id, planned: true, date: feedback.removedDate }); else await mutate({ type: 'setCompleted', id: current.id, completed: feedback.task.completed, expectedRevision: current.revision }); } setFeedback(null); })}>{feedback.removedDate ? '重新加入' : '撤销'}</button><button aria-label="关闭完成提示" onClick={() => setFeedback(null)}><X size={12}/></button></div>}
    <footer className="edge-footer"><button className="manage-button" onClick={() => void perform(() => openConsole('today'))}>管理任务</button><div><button className="icon-button" title="设置" aria-label="打开设置" onClick={() => void perform(() => openConsole('settings'))}><Settings2 size={16}/></button></div></footer>
    <button className="panel-size-grip" data-edge={snapshot.settings.edge} aria-label="调整小窗宽度和高度" title="拖动调整尺寸；方向键每次调整 10 逻辑像素，松开保存，Esc 取消" {...resizeProps}><svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m5 12 7-7m-3 7 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
  </div>;
}
