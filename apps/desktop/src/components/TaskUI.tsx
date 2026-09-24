import { CalendarDays, Check, ChevronRight, Flag, Plus, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Task } from '../lib/types';
import { formatDue, isOverdue } from '../lib/domain';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className={`brand ${compact ? 'brand-compact' : ''}`}><svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="8" fill="currentColor"/><path d="M11 10.5h10M11 16h7M11 21.5h4" stroke="var(--brand-line, #fff)" strokeWidth="2" strokeLinecap="round"/><path d="M24 7v18" stroke="var(--brand-line, #fff)" strokeWidth="1.5" opacity=".35"/></svg><span className="brand-name">侧笺<span>SideTask</span></span></span>;
}
export function CheckButton({ task, onToggle, disabled }: { task: Task; onToggle: () => void; disabled?: boolean }) {
  return <button className={`task-check ${task.completed ? 'is-checked' : ''} ${task.priority === 'high' && !task.completed ? 'is-high' : ''}`} aria-label={`${task.completed ? '撤销完成' : '完成'}：${task.title}`} aria-pressed={task.completed} onClick={e => { e.stopPropagation(); onToggle(); }} disabled={disabled}>{task.completed && <Check size={12} strokeWidth={2.8} />}</button>;
}
export function TaskRow({ task, selected, today, compact = false, onSelect, onToggle, onPlan, disabled }: { task: Task; selected?: boolean; today?: boolean; compact?: boolean; onSelect: () => void; onToggle: () => void; onPlan?: () => void; disabled?: boolean }) {
  const due = task.dueDate ? formatDue(task) : '';
  const overdue = isOverdue(task);
  return <div className={`task-row ${selected ? 'is-selected' : ''} ${task.completed ? 'is-completed' : ''} ${compact ? 'task-row-compact' : ''}`}>
    <CheckButton task={task} onToggle={onToggle} disabled={disabled}/>
    <button className="task-open" title={compact ? task.title : undefined} onClick={onSelect} aria-label={`编辑任务：${task.title}`}><span className="task-title">{task.title}</span><span className="task-meta">{task.priority === 'high' && <span className="priority-high"><Flag size={11}/>高优先级</span>}{task.priority === 'low' && <span>低优先级</span>}{due && <span className={overdue ? 'due-overdue' : ''}><CalendarDays size={12}/>{due}</span>}{today && <span className="today-indicator"><Sun size={12}/>今日</span>}{!due && task.priority === 'normal' && !today && <span>未设截止日期</span>}</span></button>
    {onPlan && !today && !task.completed ? <button className="row-plan icon-button" aria-label={`将${task.title}加入今日`} title="加入今日" onClick={onPlan} disabled={disabled}><Plus size={15}/></button> : <ChevronRight className="row-chevron" size={14}/>}
  </div>;
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol">{icon || <Sun size={26} strokeWidth={1.4}/>}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) { return <button type="button" className={`toggle ${checked ? 'toggle-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span/></button>; }
