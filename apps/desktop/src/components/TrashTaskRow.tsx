import { CalendarDays, RotateCcw, Trash2 } from 'lucide-react';
import { formatDue } from '../lib/domain';
import type { Task } from '../lib/types';

export function removedAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

export function TrashTaskRow({ task, selected, disabled, onSelect, onRestore }: {
  task: Task; selected?: boolean; disabled: boolean; onSelect: () => void; onRestore: () => Promise<void>;
}) {
  return <div className={`task-row trash-task-row ${selected ? 'is-selected' : ''}`}>
    <Trash2 size={17} className="trash-task-symbol" aria-hidden="true"/>
    <button className="task-open" onClick={onSelect} aria-label={`查看已删除任务：${task.title}`}>
      <span className="task-title">{task.title}</span>
      <span className="task-meta">
        <span>{task.completed ? '原状态：已完成' : '未完成'}</span>
        {task.dueDate && <span><CalendarDays size={12}/>{formatDue(task)}</span>}
        <span>移入于 {removedAt(task.deletedAt!)}</span>
      </span>
    </button>
    <button className="trash-restore" disabled={disabled} onClick={async event => {
      const button = event.currentTarget;
      const hadFocus = document.activeElement === button;
      try { await onRestore(); }
      catch {
        // Disabling a focused native button can drop focus to the document.
        // Return it on failure only if the user has not moved somewhere else.
        if (hadFocus) requestAnimationFrame(() => {
          if (button.isConnected && !button.disabled && (document.activeElement === document.body || !document.activeElement?.isConnected)) button.focus({ preventScroll: true });
        });
      }
    }} aria-label={`恢复任务：${task.title}`}>
      <RotateCcw size={14}/><span>恢复</span>
    </button>
  </div>;
}
