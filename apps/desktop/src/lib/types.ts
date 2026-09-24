export type Priority = 'high' | 'normal' | 'low';
export type UIStyle = 'paper' | 'studio' | 'editorial' | 'mono';
export type Page = 'today' | 'all' | 'deadlines' | 'completed' | 'trash' | 'settings';
export interface Task {
  id: string;
  title: string;
  notes: string;
  priority: Priority;
  dueDate: string | null;
  dueTime: string | null;
  /** Missing/null denotes a legacy deadline whose zone has not been confirmed. */
  dueTimezone?: string | null;
  /** Server-derived UTC instant for a fixed precise deadline. */
  dueAtUtc?: string | null;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
  /** Missing/null means visible; trash preserves completion, deadlines and plans. */
  deletedAt?: string | null;
  revision: number;
}
export interface Plan { taskId: string; date: string; sortOrder: number }
export interface Settings {
  edge: 'left' | 'right';
  panelWidth: number;
  panelHeight: number;
  revealDelay: number;
  hideDelay: number;
  pinned: boolean;
  edgeEnabled: boolean;
  theme: 'light' | 'dark' | 'system';
  uiStyle: UIStyle;
  ddlSort: 'date' | 'priority';
}
export interface Snapshot {
  tasks: Task[];
  plans: Plan[];
  settings: Settings;
  revision: number;
}
export type TaskChanges = Partial<Pick<Task, 'title' | 'notes' | 'priority' | 'dueDate' | 'dueTime' | 'dueTimezone'>>;
export type Action =
  | { type: 'createTask'; task: { title: string; notes: string; priority: Priority; dueDate: string | null; dueTime: string | null; dueTimezone?: string | null; addToToday: boolean }; date: string }
  | { type: 'updateTask'; id: string; changes: TaskChanges; expectedRevision: number }
  | { type: 'setCompleted'; id: string; completed: boolean; expectedRevision: number }
  | { type: 'trashTask'; id: string; expectedRevision: number }
  | { type: 'restoreTask'; id: string; expectedRevision: number }
  | { type: 'planTask'; id: string; planned: boolean; date: string }
  | { type: 'reorderToday'; date: string; taskIds: string[] }
  | { type: 'updateSettings'; changes: Partial<Settings> }
  | { type: 'resetDemo'; date: string };
export interface MonitorInfo { name: string; width: number; height: number; scaleFactor: number; current: boolean }
