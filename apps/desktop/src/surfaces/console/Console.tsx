import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FormEvent, ReactNode } from 'react';
import { ArrowDownWideNarrow, CalendarDays, Check, CheckCheck, ChevronDown, Clock3, Inbox, LoaderCircle, Monitor, Moon, PanelRight, Plus, Search, Settings2, Sun, X } from 'lucide-react';
import { useAppStore } from '../../lib/store';
import type { Action, Page, Priority, Settings, Task, TaskChanges } from '../../lib/types';
import { currentTimeZone, indexSnapshot, localDate, selectDeadlines } from '../../lib/domain';
import { attachExitRequests, isDesktop, resolveExit, setInteractionLock, windowAction } from '../../lib/native';
import { Brand, EmptyState, TaskRow, Toggle } from '../../components/TaskUI';
import { StylePicker } from '../../components/StylePicker';
import { VirtualTaskList } from '../../components/VirtualTaskList';
import { DraftProvider, useDraft, useDrafts } from '../../lib/drafts';

const pageTitles: Record<Page, string> = { today: '今日', all: '全部任务', deadlines: '截止日期', completed: '已完成', settings: '设置' };
const icons = { today: Sun, all: Inbox, deadlines: CalendarDays, completed: CheckCheck, settings: Settings2 };
const priorities: { value: Priority; label: string }[] = [{ value: 'high', label: '高' }, { value: 'normal', label: '普通' }, { value: 'low', label: '低' }];
function getInitialPage(): Page { const value = new URLSearchParams(location.search).get('page'); return value && Object.hasOwn(pageTitles, value) ? value as Page : 'today'; }
export default function Console() { return <DraftProvider><ConsoleContent /></DraftProvider>; }
function ConsoleContent() {
  const { snapshot, loading, error, busy, mutate, clearError } = useAppStore();
  const [page, setPage] = useState<Page>(getInitialPage);
  const [selectedId, setSelectedId] = useState<string | null>(new URLSearchParams(location.search).get('taskId'));
  const [query, setQuery] = useState('');
  const [newTask, setNewTask] = useState(new URLSearchParams(location.search).get('newTask') === '1');
  const [showCompleted, setShowCompleted] = useState(true);
  const [toast, setToast] = useState<{ message: string; undo?: () => Promise<void>; actionLabel?: string } | null>(null);
  const { dirty: draftDirty, saveAll, discardAll } = useDrafts();
  const [exitRequest, setExitRequest] = useState<number | null>(null);
  const [resolving, setResolving] = useState(false);
  const [exitFailure, setExitFailure] = useState('');
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void attachExitRequests(setExitRequest).then(cleanup => { if (disposed) cleanup(); else stop = cleanup; }).catch(reason => setExitFailure(String(reason)));
    return () => { disposed = true; stop?.(); };
  }, []);
  useEffect(() => {
    if (exitRequest === null || draftDirty || busy || resolving) return;
    setResolving(true);
    void resolveExit(exitRequest, true).then(() => setExitRequest(null)).catch(reason => { setExitFailure(String(reason)); setExitRequest(null); }).finally(() => setResolving(false));
  }, [exitRequest, draftDirty, busy, resolving]);
  async function finishExit(save: boolean) {
    if (exitRequest === null || busy || resolving) return;
    setResolving(true); setExitFailure('');
    try {
      if (save && !await saveAll()) { setExitFailure('保存未完成，请继续编辑并核对输入或冲突。'); return; }
      await resolveExit(exitRequest, true);
      if (!save) discardAll();
      setExitRequest(null);
    } catch (reason) { setExitFailure(String(reason)); } finally { setResolving(false); }
  }
  async function cancelExit() {
    if (exitRequest === null || resolving) return;
    try { await resolveExit(exitRequest, false); setExitRequest(null); setExitFailure(''); } catch (reason) { setExitFailure(String(reason)); }
  }
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listScroll = useRef<HTMLElement>(null);
  const day = localDate();
  const zone = currentTimeZone();
  const searching = !!query.trim();
  // Snapshot identity changes on commits and clock boundaries; local day/zone
  // also invalidate projections when another UI event observes a clock change.
  const view = useMemo(() => snapshot ? indexSnapshot(snapshot, day) : null, [snapshot, day]);
  const todayPositions = useMemo(() => new Map(view?.activeToday.map((task, index) => [task.id, index]) ?? []), [view]);
  const deadlines = useMemo(() => snapshot && page === 'deadlines' ? selectDeadlines(snapshot, zone) : [], [snapshot, page, zone]);
  const tasks = useMemo(() => {
    if (!view) return [];
    const term = query.toLowerCase().trim();
    if (term) return snapshot!.tasks.filter(task => `${task.title} ${task.notes}`.toLowerCase().includes(term));
    const source = page === 'today' ? view.activeToday : page === 'deadlines' ? deadlines : page === 'completed'
      ? [...view.completed].sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')) : view.active;
    return source;
  }, [snapshot, view, page, deadlines, query]);
  const selected = selectedId ? view?.byId.get(selectedId) : undefined;
  const dateText = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const navigate = (callback: () => void) => { if (busy || resolving) return; if (draftDirty) setPendingNavigation(() => callback); else callback(); };
  useEffect(() => { const handler = (event: Event) => { const detail = (event as CustomEvent<{ page?: Page; taskId?: string }>).detail; if (!detail || typeof detail !== 'object') return; navigate(() => { if (detail.page && Object.hasOwn(pageTitles, detail.page)) setPage(detail.page); setSelectedId(detail.taskId || null); setQuery(''); if ((detail as { newTask?: boolean }).newTask) setNewTask(true); }); }; window.addEventListener('sidetask:navigate', handler); return () => window.removeEventListener('sidetask:navigate', handler); }, [draftDirty, busy, resolving]);
  useEffect(() => { const create = () => setNewTask(true); window.addEventListener('sidetask:new-task', create); return () => window.removeEventListener('sidetask:new-task', create); }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.isComposing || busy || resolving) return; const input = event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); setNewTask(true); } else if (event.key === '/' && !input && !newTask) { event.preventDefault(); searchRef.current?.focus(); } else if (event.key === 'Escape' && !input && !newTask && !pendingNavigation) { navigate(() => setSelectedId(null)); searchRef.current?.blur(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [newTask, draftDirty, pendingNavigation, busy, resolving]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (draftDirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [draftDirty, busy, resolving]);
  async function run(action: Action, message?: string) { try { await mutate(action); if (message) setToast({ message }); } catch { /* Store exposes the recoverable error. */ } }
  async function toggleTask(task: Task) { try { await mutate({ type: 'setCompleted', id: task.id, completed: !task.completed, expectedRevision: task.revision }); setToast({ message: task.completed ? '已恢复为未完成' : '任务已完成', undo: async () => { await mutate({ type: 'setCompleted', id: task.id, completed: task.completed, expectedRevision: task.revision + 1 }); } }); } catch { /* Display store error. */ } }
  async function showPanel() { try { await windowAction('showPanel'); } catch (reason) { setToast({ message: reason instanceof Error ? reason.message : '小窗暂时无法打开，请重试' }); } }
  async function moveToday(task: Task, direction: -1 | 1) {
    if (!view || busy) return;
    const before = view.activeToday.map(item => item.id);
    const index = todayPositions.get(task.id);
    if (index === undefined || index + direction < 0 || index + direction >= before.length) return;
    const ordered = [...before];
    [ordered[index], ordered[index + direction]] = [ordered[index + direction], ordered[index]];
    try {
      await mutate({ type: 'reorderToday', date: day, taskIds: ordered });
      setToast({ message: '今日顺序已调整', undo: async () => { await mutate({ type: 'reorderToday', date: day, taskIds: before }); } });
    } catch { /* Keep the last committed order and show the store error. */ }
  }
  async function removeToday(task: Task) {
    try {
      await mutate({ type: 'planTask', id: task.id, planned: false, date: day });
      setToast({ message: '已移出今日，任务仍保留', actionLabel: '重新加入今日', undo: async () => { await mutate({ type: 'planTask', id: task.id, planned: true, date: day }); } });
    } catch { /* No false success on a failed plan write. */ }
  }
  if (loading || !snapshot || !view) return <div className="app-loading"><Brand/><LoaderCircle className="spin" size={20}/><p>{error || '正在加载任务…'}</p>{error && <button className="primary-button" onClick={() => location.reload()}>重新加载</button>}</div>;
  const { today, activeToday, completedToday, earlier: backlog, active: allActive } = view;
  const total = today.length;
  const row = (task: Task) => {
    const position = todayPositions.get(task.id);
    const arrange = page === 'today' && !searching && position !== undefined;
    return <TaskRow key={task.id} task={task} today={(searching || page !== 'today') && view.todayIds.has(task.id)} selected={task.id === selectedId} disabled={busy} onSelect={() => navigate(() => setSelectedId(task.id))} onToggle={() => toggleTask(task)} onPlan={searching || page !== 'today' ? () => void run({ type: 'planTask', id: task.id, planned: true, date: day }, '已加入今日计划') : undefined}
      onMoveUp={arrange && position > 0 ? () => void moveToday(task, -1) : undefined}
      onMoveDown={arrange && position < activeToday.length - 1 ? () => void moveToday(task, 1) : undefined}
      onRemoveToday={arrange ? () => void removeToday(task) : undefined}/>;
  };
  return <div className="console-shell">
    <aside className="sidebar"><div className="sidebar-brand"><Brand/></div><nav aria-label="主导航">{(['today','all','deadlines','completed'] as Page[]).map(item => { const Icon = icons[item]; const count = item === 'today' ? activeToday.length : item === 'all' ? allActive.length : item === 'deadlines' ? view.deadlineCount : view.completed.length; return <button key={item} className={`nav-item ${page === item ? 'nav-active' : ''}`} onClick={() => navigate(() => { setPage(item); setSelectedId(null); setQuery(''); })}><Icon size={17} strokeWidth={1.65}/><span>{pageTitles[item]}</span><span className="nav-count">{count}</span></button>; })}</nav><div className="sidebar-bottom"><button className="nav-item" onClick={() => void showPanel()}><PanelRight size={17}/><span>打开边缘小窗</span></button><button className={`nav-item ${page === 'settings' ? 'nav-active' : ''}`} onClick={() => navigate(() => { setPage('settings'); setSelectedId(null); setQuery(''); })}><Settings2 size={17}/><span>设置</span></button></div></aside>
    <div className="workspace"><header className="workspace-toolbar"><div className="breadcrumb"><span>我的任务</span><span>/</span><strong>{pageTitles[page]}</strong></div><div className="toolbar-actions">{page !== 'settings' && <label className="search-box"><Search size={15}/><input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索全部任务" aria-label="搜索任务"/><kbd>/</kbd>{query && <button className="icon-button" title="清除搜索" onClick={() => setQuery('')}><X size={13}/></button>}</label>}<button className="primary-button new-task-button" disabled={busy || resolving} onClick={() => setNewTask(true)}><Plus size={16}/>新建任务</button></div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={clearError} aria-label="关闭错误提示"><X size={15}/></button></div>}
      <div className="workspace-body"><main ref={listScroll} className={`main-content ${page === 'settings' ? 'settings-content' : ''}`}>
      {page === 'settings' ? <SettingsPage settings={snapshot.settings} busy={busy} save={changes => mutate({ type: 'updateSettings', changes })} onSaved={() => setToast({ message: '设置已保存' })} /> : <><div className="page-heading"><div><h1>{pageTitles[page]}</h1>{page === 'today' && <p className="page-date">{dateText}</p>}</div></div>
      <div className="list-heading"><div><span>{searching ? '全部任务中的搜索结果' : page === 'today' ? '今日计划' : page === 'completed' ? '完成记录' : page === 'deadlines' ? '即将到来' : '未完成任务'}</span><span className="count-badge">{tasks.length}</span></div>{page === 'deadlines' && !searching ? <label className="sort-control"><ArrowDownWideNarrow size={14}/><select aria-label="截止任务排序" value={snapshot.settings.ddlSort} onChange={event => void run({ type: 'updateSettings', changes: { ddlSort: event.target.value as Settings['ddlSort'] } })}><option value="date">按截止日期</option><option value="priority">按重要程度</option></select><ChevronDown size={12}/></label> : <span className="list-hint">{searching ? '包含未完成和已完成任务' : page === 'today' ? `已完成 ${completedToday.length} / ${total}` : page === 'completed' ? '最近完成在前' : '点击任务查看详情'}</span>}</div>
      <div className="task-list">{tasks.length ? <VirtualTaskList items={tasks} renderItem={row} scrollRef={listScroll} resetKey={`${page}:${query.trim()}:${page === 'deadlines' && !searching ? snapshot.settings.ddlSort : ''}`} label={searching ? '全部任务搜索结果' : pageTitles[page]} /> : <EmptyState icon={page === 'completed' ? <CheckCheck size={27}/> : <Sun size={27}/>} title={searching ? '没有找到相关任务' : page === 'today' && total ? '今日计划已全部完成' : page === 'today' ? '今日暂无任务' : page === 'deadlines' ? '暂时没有截止日期' : page === 'completed' ? '暂无已完成任务' : '暂无任务'} description={searching ? '试试其他关键词，或创建一项新任务。' : page === 'today' && total ? '可在下方查看已完成的任务。' : page === 'today' ? snapshot.tasks.length ? '添加今日任务，或从全部任务中加入今日。' : '新建第一项任务。边缘小窗可快速查看；关闭控制台后，可从菜单栏或托盘重新打开。' : page === 'deadlines' ? '为任务设置日期后，它就会出现在这里。' : page === 'completed' ? '勾选已做完的任务，在这里回顾你的进展。' : '点击“新建任务”，添加第一项任务。'}/>}</div>
      {page !== 'completed' && <button className="add-task-row" disabled={busy || resolving} onClick={() => setNewTask(true)}><span><Plus size={15}/></span>{page === 'today' ? '添加今日任务' : '添加任务'}<kbd>⌘ / Ctrl N</kbd></button>}
      {page === 'today' && !searching && completedToday.length > 0 && <section className="completed-section"><button className="section-disclosure" onClick={() => setShowCompleted(!showCompleted)}><ChevronDown size={14} className={showCompleted ? '' : 'is-collapsed'}/>已完成<span>{completedToday.length}</span></button>{showCompleted && <VirtualTaskList items={completedToday} renderItem={row} scrollRef={listScroll} label="今日已完成任务" />}</section>}
      {page === 'today' && !searching && backlog.length > 0 && <section className="backlog-section"><div className="list-heading"><div><span>此前未完成</span><span className="count-badge">{backlog.length}</span></div><span className="list-hint">可重新加入今日</span></div>{<VirtualTaskList items={backlog} scrollRef={listScroll} label="此前未完成任务" renderItem={task => <TaskRow key={task.id} task={task} disabled={busy} selected={task.id === selectedId} onSelect={() => navigate(() => setSelectedId(task.id))} onToggle={() => toggleTask(task)} onPlan={() => void run({ type: 'planTask', id: task.id, planned: true, date: localDate() }, '已加入今日计划')}/>} />}</section>}
      </>}
      </main>{selected && page !== 'settings' && <TaskDetail key={selected.id} task={selected} planned={view.todayIds.has(selected.id)} busy={busy} onClose={() => navigate(() => { setSelectedId(null); })}  onSave={async (changes, revision) => { await mutate({ type: 'updateTask', id: selected.id, changes, expectedRevision: revision }); setToast({ message: '任务已保存' }); }} onPlan={() => run({ type: 'planTask', id: selected.id, planned: !view.todayIds.has(selected.id), date: localDate() }, view.todayIds.has(selected.id) ? '已移出今日，任务和截止日期已保留' : '已加入今日计划')} onToggle={() => toggleTask(selected)}/>}</div>
      <footer className="workspace-statusbar"><span><span className={`status-dot ${busy ? 'is-busy' : ''}`}/>{busy ? '正在保存…' : draftDirty ? '有尚未保存的修改' : error ? '操作未完成，请查看错误提示' : '更改已保存在本机'}</span><button onClick={() => void showPanel()}><PanelRight size={13}/>边缘小窗</button></footer>
    </div>
    {newTask && <NewTaskModal busy={busy} addToToday={page === 'today'} onClose={() => setNewTask(false)} onSubmit={async task => { await mutate({ type: 'createTask', task, date: localDate() }); setNewTask(false); setToast({ message: task.addToToday ? '已添加到今日计划' : '任务已创建' }); }}/>}
    {pendingNavigation && <Modal onClose={() => setPendingNavigation(null)} title="保留正在编辑的内容？"><p className="dialog-description">还有未保存的修改。你可以继续编辑，或放弃修改并离开。</p><div className="dialog-footer"><button className="secondary-button" disabled={busy || resolving} onClick={() => { discardAll(); pendingNavigation(); setPendingNavigation(null); }}>放弃修改</button><button className="secondary-button" disabled={busy || resolving} onClick={async () => { setResolving(true); try { if (await saveAll()) { pendingNavigation(); setPendingNavigation(null); } } finally { setResolving(false); } }}>保存并离开</button><button className="primary-button" onClick={() => setPendingNavigation(null)}>继续编辑</button></div></Modal>}
    {exitRequest !== null && draftDirty && <Modal onClose={() => void cancelExit()} title="退出前保存修改？"><p className="dialog-description">还有未保存的任务或设置。保存成功后才能退出；取消会保留当前编辑。</p>{exitFailure && <p className="inline-error" role="alert">{exitFailure}</p>}<div className="dialog-footer"><button className="secondary-button" disabled={busy || resolving} onClick={() => void cancelExit()}>取消退出</button><button className="secondary-button" disabled={busy || resolving} onClick={() => void finishExit(false)}>放弃并退出</button><button className="primary-button" disabled={busy || resolving} onClick={() => void finishExit(true)}>保存并退出</button></div></Modal>}
    {exitFailure && exitRequest === null && <div className="error-banner" role="alert">{exitFailure}</div>}
    {toast && <div className="toast" role="status"><Check size={15}/><span>{toast.message}</span>{toast.undo && <button onClick={async () => { try { await toast.undo?.(); setToast({ message: toast.actionLabel ? '已重新加入今日' : '已撤销' }); } catch { setToast(null); } }}>{toast.actionLabel || '撤销'}</button>}<button aria-label="关闭提示" onClick={() => setToast(null)}><X size={13}/></button></div>}
  </div>;
}

function TaskDetail({ task, planned, busy, onClose, onSave, onPlan, onToggle }: { task: Task; planned: boolean; busy: boolean; onClose: () => void; onSave: (changes: TaskChanges, revision: number) => Promise<void>; onPlan: () => void; onToggle: () => void }) {
  const [draft, setDraft] = useState({ title: task.title, notes: task.notes, priority: task.priority, dueDate: task.dueDate || '', dueTime: task.dueTime || '' });
  const [base, setBase] = useState(task);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify({ title: base.title, notes: base.notes, priority: base.priority, dueDate: base.dueDate || '', dueTime: base.dueTime || '' });
  const conflict = task.revision !== base.revision && dirty;

  useEffect(() => { if (!dirty) { setBase(task); setDraft({ title: task.title, notes: task.notes, priority: task.priority, dueDate: task.dueDate || '', dueTime: task.dueTime || '' }); } }, [task.revision]);
  const change = (key: keyof typeof draft, value: string) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false); };
  const formRef = useRef<HTMLFormElement>(null);
  async function saveDraft(): Promise<boolean> {
    if (busy || conflict || !draft.title.trim() || !formRef.current?.reportValidity()) return false;
    setFailure('');
    const deadlineChanged = draft.dueDate !== (base.dueDate || '') || draft.dueTime !== (base.dueTime || '');
    const changes: TaskChanges = { ...draft, title: draft.title.trim(), dueDate: draft.dueDate || null, dueTime: draft.dueDate && draft.dueTime ? draft.dueTime : null };
    if (deadlineChanged) changes.dueTimezone = draft.dueDate ? base.dueTimezone || currentTimeZone() : null;
    try {
      await onSave(changes, base.revision);
      setDraft(current => ({ ...current, title: changes.title!, dueTime: changes.dueTime || '' }));
      setBase({ ...task, ...changes, revision: base.revision + 1 }); setSaved(true); return true;
    } catch { setFailure('保存未完成。你的草稿已保留，请核对后重试。'); return false; }
  }
  useDraft('task-detail', { dirty, save: saveDraft, discard: () => { setDraft({ title: task.title, notes: task.notes, priority: task.priority, dueDate: task.dueDate || '', dueTime: task.dueTime || '' }); setBase(task); } });
  async function submit(event: FormEvent) { event.preventDefault(); await saveDraft(); }
  return <aside className="task-detail"><header><span>任务详情</span><button className="icon-button" onClick={onClose} aria-label="关闭任务详情"><X size={17}/></button></header><form ref={formRef} onSubmit={submit}><fieldset disabled={busy} className="form-fields"><div className="detail-status"><span className={`task-state-pill ${task.completed ? 'completed-pill' : ''}`}>{task.completed ? <Check size={11}/> : <span className="state-circle"/>}{task.completed ? '已完成' : '进行中'}</span></div><label className="sr-only" htmlFor="detail-title">任务名称</label><textarea id="detail-title" className="detail-title" rows={2} value={draft.title} onChange={event => change('title', event.target.value)} maxLength={240} required/><div className="detail-divider"/><div className="detail-field"><label htmlFor="detail-date"><CalendarDays size={15}/>截止日期</label><input id="detail-date" type="date" value={draft.dueDate} onChange={event => { change('dueDate', event.target.value); if (!event.target.value) change('dueTime', ''); }}/></div>{draft.dueDate && <div className="detail-field"><label htmlFor="detail-time"><Clock3 size={15}/>具体时间</label><input id="detail-time" type="time" value={draft.dueTime} onChange={event => change('dueTime', event.target.value)} title="留空表示当天结束前"/></div>}<p className="detail-note">{draft.dueDate ? base.dueTimezone || (draft.dueDate !== (base.dueDate || '') || draft.dueTime !== (base.dueTime || '') ? currentTimeZone() : '旧截止日期随系统时区解释；修改截止日期后固定时区') : ''}</p><div className="detail-field priority-field"><label htmlFor="detail-priority"><ArrowDownWideNarrow size={15}/>重要程度</label><select id="detail-priority" value={draft.priority} onChange={event => change('priority', event.target.value)}>{priorities.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div><div className="detail-field"><span className="field-label"><Sun size={15}/>今日计划</span><button className={`plan-chip ${planned ? 'is-planned' : ''}`} type="button" disabled={busy} onClick={onPlan}>{planned ? <Check size={12}/> : <Plus size={12}/>} {planned ? '已安排' : '加入今日'}</button></div><div className="detail-divider"/><label className="notes-label" htmlFor="detail-notes">备注<span>可选</span></label><textarea id="detail-notes" className="notes-input" value={draft.notes} placeholder="记下背景、想法，或需要留意的事…" onChange={event => change('notes', event.target.value)} rows={3} maxLength={5000}/>{conflict && <div className="inline-warning">任务已在另一处修改，你的草稿仍保留。<button type="button" onClick={() => { setBase(task); setFailure(''); }}>保留草稿，基于最新版本保存</button></div>}{failure && <p className="inline-error" role="alert">{failure}</p>}<div className="detail-actions"><button className="primary-button" type="submit" disabled={busy || !dirty || !draft.title.trim() || conflict}>{busy ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>} {saved && !dirty ? '已保存' : '保存修改'}</button><button className="secondary-button" type="button" disabled={busy} onClick={onToggle}>{task.completed ? '撤销完成' : '标记完成'}</button></div><p className="detail-note">{planned ? '在今日或小窗中完成，这里也会同步。' : '加入今日只安排计划，不会改变截止日期。'}</p></fieldset></form><footer>创建于 {new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(task.createdAt))}</footer></aside>;
}

const modalStack: string[] = [];
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    modalStack.push(id);
    const autofocus = element?.querySelector<HTMLElement>('[autofocus]') || element?.querySelector<HTMLElement>('input,textarea,select') || element?.querySelector<HTMLElement>('button');
    autofocus?.focus();
    void setInteractionLock(true).catch(() => {});
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || modalStack.at(-1) !== id) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      if (event.key === 'Tab') {
        const elements = Array.from(element?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || []).filter(item => item.getClientRects().length > 0);
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        else if (!element?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      const index = modalStack.indexOf(id); if (index >= 0) modalStack.splice(index, 1);
      if (!modalStack.length) void setInteractionLock(false).catch(() => {});
      if (previous?.isConnected) previous.focus();
    };
  }, [id]);
  return <div className="modal-backdrop"><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={id}><header><h2 id={id}>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭对话框"><X size={19}/></button></header>{children}</div></div>;
}
function NewTaskModal({ busy, addToToday, onClose, onSubmit }: { busy: boolean; addToToday: boolean; onClose: () => void; onSubmit: (task: Extract<Action, { type: 'createTask' }>['task']) => Promise<void> }) {
  const [title, setTitle] = useState(''); const [notes, setNotes] = useState(''); const [date, setDate] = useState(''); const [time, setTime] = useState(''); const [priority, setPriority] = useState<Priority>('normal'); const [planned, setPlanned] = useState(addToToday); const [failure, setFailure] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = !!(title || notes || date || time || priority !== 'normal' || planned !== addToToday);
  async function saveDraft(): Promise<boolean> { if (!title.trim() || busy || !formRef.current?.reportValidity()) return false; try { await onSubmit({ title: title.trim(), notes, priority, dueDate: date || null, dueTime: date && time ? time : null, dueTimezone: date ? currentTimeZone() : null, addToToday: planned }); return true; } catch { setFailure('暂时无法保存，输入内容已保留，请重试。'); return false; } }
  useDraft('new-task', { dirty, save: saveDraft, discard: onClose });
  const requestClose = () => { if (busy) return; if (dirty) setConfirmClose(true); else onClose(); };
  async function submit(event: FormEvent) { event.preventDefault(); await saveDraft(); }
  return <><Modal title="新建任务" onClose={requestClose}><form ref={formRef} className="new-task-form" onSubmit={submit}><fieldset disabled={busy} className="form-fields"><label htmlFor="new-title">任务名称</label><input id="new-title" autoFocus placeholder="例如：完成这周的阅读报告" value={title} onChange={event => setTitle(event.target.value)} maxLength={240} required/><div className="form-two-cols"><div><label htmlFor="new-date">截止日期 <span>可选</span></label><input id="new-date" type="date" value={date} onChange={event => { setDate(event.target.value); if (!event.target.value) setTime(''); }}/></div><div><label htmlFor="new-priority">重要程度</label><select id="new-priority" value={priority} onChange={event => setPriority(event.target.value as Priority)}>{priorities.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div>{date && <div className="new-time-field"><label htmlFor="new-time">具体时间 <span>留空表示当天结束前</span></label><input id="new-time" type="time" value={time} onChange={event => setTime(event.target.value)}/></div>}<p className="detail-note">{date ? `截止日期时区：${currentTimeZone()}` : ''}</p><label htmlFor="new-notes">备注 <span>可选</span></label><textarea id="new-notes" placeholder="添加任务相关说明" rows={3} value={notes} onChange={event => setNotes(event.target.value)} maxLength={5000}/><div className="new-task-plan"><div><Sun size={17}/><span>安排到今日</span></div><Toggle checked={planned} onChange={setPlanned} label="安排到今日"/></div>{failure && <p className="inline-error" role="alert">{failure}</p>}<div className="dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={requestClose}>取消</button><button className="primary-button" type="submit" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={15} className="spin"/> : <Plus size={15}/>}创建任务</button></div></fieldset></form></Modal>{confirmClose && <Modal title="保留新任务草稿？" onClose={() => setConfirmClose(false)}><p className="dialog-description">新任务尚未保存。</p><div className="dialog-footer"><button className="secondary-button" onClick={onClose}>放弃新任务</button><button className="primary-button" onClick={() => setConfirmClose(false)}>继续编辑</button></div></Modal>}</>;
}

function SettingsPage({ settings, busy, save, onSaved }: { settings: Settings; busy: boolean; save: (changes: Partial<Settings>) => Promise<void>; onSaved: () => void }) {
  const [windowStatus, setWindowStatus] = useState<{ pending: boolean; error: string | null } | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false; let stop: (() => void) | undefined;
    void (async () => {
      try {
        const cleanup = await listen<{ pending: boolean; error: string | null }>('sidetask:window-status', ({ payload }) => { if (!disposed) setWindowStatus(payload); });
        if (disposed) { cleanup(); return; } stop = cleanup;
        const current = await invoke<{ pending: boolean; error: string | null }>('get_window_status');
        if (!disposed) setWindowStatus(current);
      } catch (reason) { if (!disposed) setWindowStatus({ pending: true, error: String(reason) }); }
    })();
    return () => { disposed = true; stop?.(); };
  }, []);
  const [changes, setChanges] = useState<Partial<Settings>>({}); const [failure, setFailure] = useState(''); const draft = { ...settings, ...changes }; const dirty = Object.entries(changes).some(([key, value]) => settings[key as keyof Settings] !== value);

  const [baseSettings, setBaseSettings] = useState(settings);
  const conflict = Object.entries(changes).some(([key, value]) => baseSettings[key as keyof Settings] !== settings[key as keyof Settings] && value !== settings[key as keyof Settings]);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (!Object.hasOwn(changes, key)) setBaseSettings(previous => ({ ...previous, [key]: settings[key] }));
    setChanges(previous => ({ ...previous, [key]: value }));
  };
  const formRef = useRef<HTMLFormElement>(null);
  async function saveDraft(): Promise<boolean> { if (busy || conflict || !formRef.current?.reportValidity()) return false; setFailure(''); try { await save(changes); setChanges({}); setBaseSettings(settings); onSaved(); return true; } catch { setFailure('设置未能应用，修改已保留。请重试。'); return false; } }
  useDraft('settings', { dirty, save: saveDraft, discard: () => { setChanges({}); setBaseSettings(settings); } });
  const submit = async (event: FormEvent) => { event.preventDefault(); await saveDraft(); };
  return <><div className="page-heading"><h1>设置</h1></div><form ref={formRef} className="settings-form" onSubmit={submit}><fieldset disabled={busy} className="form-fields"><StylePicker value={settings.uiStyle} busy={busy} onChange={uiStyle => save({ uiStyle })}/><section className="settings-section"><div className="settings-section-title"><PanelRight size={18}/><h2>边缘小窗</h2></div><div className="setting-row"><div><label>启用边缘入口</label><p>鼠标在屏幕边缘停留，即可查看任务。</p></div><Toggle checked={draft.edgeEnabled} onChange={value => change('edgeEnabled', value)} label="启用边缘入口"/></div><div className="setting-row"><div><label>停靠位置</label><p>也可以拖动把手，自由移动到另一侧。</p></div><div className="segmented"><button className={draft.edge === 'left' ? 'segment-active' : ''} type="button" onClick={() => change('edge', 'left')}>左侧</button><button className={draft.edge === 'right' ? 'segment-active' : ''} type="button" onClick={() => change('edge', 'right')}>右侧</button></div></div><div className="setting-row"><div><label>小窗尺寸</label><p>按当前屏幕可用空间自动调整。</p></div><div className="size-inputs"><label><input aria-label="小窗宽度" type="number" min={300} max={640} step={1} value={draft.panelWidth} onChange={event => change('panelWidth', Number(event.target.value))}/><span>宽</span></label><span>×</span><label><input aria-label="小窗高度" type="number" min={380} max={1000} step={1} value={draft.panelHeight} onChange={event => change('panelHeight', Number(event.target.value))}/><span>高</span></label></div></div><div className="setting-row"><div><label htmlFor="reveal-delay">悬停展开等待</label><p>稍作停留再展开，减少路过时的误触。</p></div><label className="unit-input"><input id="reveal-delay" type="number" min={0} max={1500} step={1} value={draft.revealDelay} onChange={event => change('revealDelay', Number(event.target.value))}/><span>ms</span></label></div><div className="setting-row"><div><label htmlFor="hide-delay">离开收起等待</label><p>鼠标离开后，等待多久收起。</p></div><label className="unit-input"><input id="hide-delay" type="number" min={100} max={2500} step={1} value={draft.hideDelay} onChange={event => change('hideDelay', Number(event.target.value))}/><span>ms</span></label></div><div className="setting-row"><div><label>保持小窗展开</label><p>暂停自动收起，仍然可以拖动位置。</p></div><Toggle checked={draft.pinned} onChange={value => change('pinned', value)} label="保持小窗展开"/></div></section><section className="settings-section"><div className="settings-section-title"><Sun size={18}/><h2>外观</h2></div><div className="theme-options">{([{value:'light',label:'浅色',icon:Sun},{value:'dark',label:'深色',icon:Moon},{value:'system',label:'跟随系统',icon:Monitor}] as const).map(item => { const Icon = item.icon; return <button key={item.value} type="button" className={`theme-option ${draft.theme === item.value ? 'theme-selected' : ''}`} onClick={() => change('theme', item.value)} aria-pressed={draft.theme === item.value}><span><Icon size={14}/>{item.label}{draft.theme === item.value && <Check size={13}/>}</span></button>; })}</div></section><DataControls/>{isDesktop && windowStatus?.error && <div className="inline-warning" role="alert">设置已保存，但窗口尚未生效：{windowStatus.error}<button type="button" disabled={busy} onClick={async () => { try { await windowAction('retryWindowSettings'); setWindowStatus(await invoke('get_window_status')); } catch (reason) { setWindowStatus({ pending: true, error: String(reason) }); } }}>重试应用窗口设置</button></div>}<section className="settings-about"><Brand compact/><span>SideTask · {isDesktop ? '内部试用版' : '交互预览版'}</span><div><span className="status-dot"/>{isDesktop ? '任务保存在本机，无需账号' : '浏览器预览 · 任务保存在当前浏览器'}</div></section>{failure && <p className="inline-error" role="alert">{failure}</p>}<div className="settings-save">{conflict && <div className="inline-warning">设置已在另一处修改，草稿已保留。<button type="button" onClick={() => setBaseSettings(settings)}>确认以我的设置草稿覆盖</button></div>}<span>{dirty ? '有尚未保存的修改' : isDesktop && !windowStatus ? '正在读取窗口状态…' : windowStatus?.error ? '设置已保存，窗口应用失败' : windowStatus?.pending ? '设置已保存，正在应用窗口…' : '设置已与应用同步'}</span><button className="primary-button" disabled={!dirty || busy || conflict} type="submit"><Check size={15}/>{busy ? '正在应用…' : '保存设置'}</button></div></fieldset></form></>;
}

function DataControls() {
  const { snapshot, busy, restoreBackup } = useAppStore();
  const { dirty } = useDrafts();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [preview, setPreview] = useState<{ content: string; revision: number; taskCount: number; planCount: number; exportedAt: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const unavailable = busy || working || dirty;
  if (!isDesktop || !snapshot) return null;
  async function exportData() {
    if (unavailable) return;
    setWorking(true); setFailure(''); setMessage('');
    try { const result = await invoke<{ path: string }>('export_backup'); setMessage(`备份已导出：${result.path}`); }
    catch (reason) { setFailure(String(reason)); } finally { setWorking(false); }
  }
  async function readFile(file?: File) {
    if (!file || unavailable || !snapshot) return;
    setWorking(true); setFailure(''); setMessage(''); setPreview(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('备份超过 10 MiB，未读取或恢复。');
      const revision = snapshot.revision;
      const content = await file.text();
      const result = await invoke<{ taskCount: number; planCount: number; exportedAt: string }>('preview_restore', { content });
      setPreview({ ...result, content, revision });
    } catch (reason) { setFailure(String(reason)); } finally { setWorking(false); }
  }
  async function restore() {
    if (!preview || unavailable) return;
    setWorking(true); setFailure('');
    try { const path = await restoreBackup(preview.content, preview.revision); setPreview(null); setMessage(`恢复完成。恢复前的完整数据库备份：${path}`); }
    catch (reason) { setFailure(String(reason)); } finally { setWorking(false); }
  }
  return <section className="settings-section"><div className="settings-section-title"><Inbox size={18}/><h2>数据备份</h2></div><p className="detail-note">导出任务与计划供迁移或恢复。恢复会替换现有任务；当前风格、窗口设置仍保留。</p><div className="setting-row"><button type="button" className="secondary-button" disabled={unavailable} onClick={() => void exportData()}>导出任务备份</button><button type="button" className="secondary-button" disabled={unavailable} onClick={() => picker.current?.click()}>选择备份恢复</button><input ref={picker} type="file" accept=".json,application/json" aria-label="选择任务备份文件" hidden onChange={event => { void readFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}/></div>{dirty && <p className="detail-note">请先保存或放弃正在编辑的修改，再备份或恢复。</p>}{message && <p className="detail-note backup-path" role="status">{message}</p>}{failure && !preview && <p className="inline-error" role="alert">{failure}</p>}{preview && <Modal title="恢复这份任务备份？" onClose={() => { if (!working) setPreview(null); }}><p className="dialog-description">包含 {preview.taskCount} 项任务、{preview.planCount} 条计划。导出时间：{new Date(preview.exportedAt).toLocaleString('zh-CN')}。</p><p className="dialog-description">确认后会先备份当前数据库，再替换任务和计划。安全备份失败时不会恢复。</p>{preview.revision !== snapshot.revision && <p className="inline-error" role="alert">任务已更新，请取消并重新选择备份，以核对最新数据。</p>}{failure && <p className="inline-error" role="alert">{failure}</p>}<div className="dialog-footer"><button type="button" className="secondary-button" disabled={working} onClick={() => setPreview(null)}>取消恢复</button><button type="button" className="primary-button" disabled={unavailable || preview.revision !== snapshot.revision} onClick={() => void restore()}>备份当前数据并恢复</button></div></Modal>}</section>;
}
