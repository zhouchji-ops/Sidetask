import type { Action, Priority, Settings, Snapshot, Task, UIStyle } from './types';
import { compareUtcInstants, dateOffset, deadlineDisplay, effectiveDeadline, fixDeadline, localDate, validDate, validateDeadline, validUtcInstant } from './deadline';
export { currentTimeZone, dateOffset, deadlineTimeZoneHint, effectiveDeadline, localDate, nextTimeBoundary } from './deadline';

const uiStyles: readonly UIStyle[] = ['paper', 'studio', 'editorial', 'mono'];
/** Read legacy browser previews without rewriting or discarding their task data. */
export function normalizePreviewSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== 'object') throw new Error('预览数据无法读取，请检查浏览器存储');
  const parsed = value as Snapshot;
  if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.plans) || !parsed.settings || typeof parsed.revision !== 'number') throw new Error('预览数据无法读取，请检查浏览器存储');
  const result = structuredClone(parsed);
  if (result.settings.uiStyle === undefined) result.settings.uiStyle = 'paper';
  validateSnapshot(result);
  return result;
}
export const priorityLabel: Record<Priority, string> = { high: '高优先级', normal: '普通', low: '低优先级' };
export function isPlannedToday(snapshot: Snapshot, taskId: string): boolean {
  return snapshot.plans.some(plan => plan.taskId === taskId && plan.date === localDate());
}
export function selectToday(snapshot: Snapshot): Task[] {
  const plans = snapshot.plans.filter(plan => plan.date === localDate()).sort((a, b) => a.sortOrder - b.sortOrder);
  return plans.map(plan => snapshot.tasks.find(task => task.id === plan.taskId)).filter((task): task is Task => !!task);
}
export function selectDeadlines(snapshot: Snapshot): Task[] {
  const ranks = { high: 0, normal: 1, low: 2 };
  return snapshot.tasks.filter(task => !!task.dueDate && !task.completed).sort((a, b) => {
    if (snapshot.settings.ddlSort === 'priority' && a.priority !== b.priority) return ranks[a.priority] - ranks[b.priority];
    return effectiveDeadline(a) - effectiveDeadline(b) || compareUtcInstants(a.createdAt, b.createdAt) || a.id.localeCompare(b.id);
  });
}
export function isOverdue(task: Task, now = Date.now()): boolean {
  return !task.completed && effectiveDeadline(task) <= now;
}
export function dueTone(task: Task): 'overdue' | 'today' | 'future' | 'none' {
  if (!task.dueDate) return 'none';
  if (isOverdue(task)) return 'overdue';
  const display = deadlineDisplay(task);
  return display.date === display.today ? 'today' : 'future';
}
export function formatDue(task: Task): string {
  if (!task.dueDate) return '无截止日期';
  const display = deadlineDisplay(task);
  const date = display.date!;
  const today = display.today;
  let label = date === today ? '今天' : date === dateOffset(today, 1) ? '明天' : `${date.slice(0, 4) !== today.slice(0, 4) ? `${Number(date.slice(0, 4))}年` : ''}${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
  if (display.time) label += ` · ${display.time}`;
  if (task.dueTimezone && task.dueTimezone !== Intl.DateTimeFormat().resolvedOptions().timeZone) label += task.dueTime ? ` · 原时区 ${task.dueTimezone}` : ` · ${task.dueTimezone}`;
  if (isOverdue(task)) label = `已逾期 · ${label}`;
  return label;
}
export function createSeed(date = localDate()): Snapshot {
  const now = new Date().toISOString();
  const task = (id: string, title: string, notes: string, priority: Priority, dueDate: string | null, completed = false, dueTime: string | null = null): Task => ({
    id, title, notes, priority, dueDate, dueTime, completed, createdAt: now, completedAt: completed ? now : null, revision: 1,
  });
  return {
    revision: 1,
    tasks: [
      task('demo-design', '完成交互设计课程作业', '把想法整理成完整的作品。检查交互流程和最终呈现，完成后提交到课程平台。', 'high', dateOffset(date, 1), false, '18:00'),
      task('demo-read', '读完《设计心理学》', '留一点完整的时间给阅读，记下真正想带走的观点。', 'normal', null),
      task('demo-paper', '提交论文开题报告', '整理选题背景、研究目标与参考资料，提交最终版本。', 'high', dateOffset(date, 3)),
      task('demo-review', '完成本周英语复习', '复习本周积累的内容，让知识慢慢沉淀。', 'low', date, true),
      task('demo-lab', '提交数据分析实验报告', '核对分析结论与图表，保留清晰的实验记录。', 'normal', dateOffset(date, 5)),
      task('demo-portfolio', '更新个人作品集', '选择最能代表自己的作品，讲清每个设计决定。', 'normal', dateOffset(date, 8)),
    ],
    plans: ['demo-design', 'demo-read', 'demo-paper', 'demo-review'].map((taskId, sortOrder) => ({ taskId, date, sortOrder })),
    settings: { edge: 'right', panelWidth: 368, panelHeight: 610, revealDelay: 180, hideDelay: 450, pinned: false, edgeEnabled: true, theme: 'light', uiStyle: 'paper', ddlSort: 'date' },
  };
}
const taskFields = ['title', 'notes', 'priority', 'dueDate', 'dueTime', 'dueTimezone'];
const settingsFields = ['edge', 'panelWidth', 'panelHeight', 'revealDelay', 'hideDelay', 'pinned', 'edgeEnabled', 'theme', 'uiStyle', 'ddlSort'];
function assertKnown(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('更改内容包含不支持的字段');
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1; }
function validateTask(task: Task): void {
  if (typeof task.title !== 'string' || !task.title.trim()) throw new Error('请为任务填写一个标题');
  if ([...task.title.trim()].length > 240) throw new Error('任务标题不能超过 240 个字');
  if (typeof task.notes !== 'string' || [...task.notes].length > 10000) throw new Error('备注不能超过 10000 个字');
  if (!['high', 'normal', 'low'].includes(task.priority)) throw new Error('重要程度无效');
  validateDeadline(task);
}
function validateSettings(s: Settings): void {
  assertKnown(s, settingsFields);
  if (!['left', 'right'].includes(s.edge) || !['light', 'dark', 'system'].includes(s.theme) || !['date', 'priority'].includes(s.ddlSort) || !uiStyles.includes(s.uiStyle) || typeof s.pinned !== 'boolean' || typeof s.edgeEnabled !== 'boolean') throw new Error('设置选项无效');
  if (!Number.isFinite(s.panelWidth) || !Number.isFinite(s.panelHeight) || s.panelWidth < 300 || s.panelWidth > 640 || s.panelHeight < 380 || s.panelHeight > 1000) throw new Error('小窗尺寸超出可用范围');
  if (!Number.isInteger(s.revealDelay) || !Number.isInteger(s.hideDelay) || s.revealDelay < 0 || s.revealDelay > 1500 || s.hideDelay < 100 || s.hideDelay > 2500) throw new Error('请选择合适的展开与收起延迟');
}
export function validateSnapshot(snapshot: Snapshot): void {
  assertKnown(snapshot, ['tasks', 'plans', 'settings', 'revision']);
  if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.plans)) throw new Error('任务或计划列表无效');
  if (!validRevision(snapshot.revision)) throw new Error('数据版本无效');
  validateSettings(snapshot.settings);
  const ids = new Set<string>();
  for (const task of snapshot.tasks) {
    assertKnown(task, [...taskFields, 'dueAtUtc', 'id', 'completed', 'createdAt', 'completedAt', 'revision']);
    validateTask(task);
    if (typeof task.id !== 'string' || !task.id.trim() || new TextEncoder().encode(task.id).length > 128 || ids.has(task.id)) throw new Error('任务 ID 无效或重复');
    if (!validRevision(task.revision) || task.revision > snapshot.revision) throw new Error('任务版本无效');
    if (!validUtcInstant(task.createdAt) || typeof task.completed !== 'boolean' || (task.completed ? !validUtcInstant(task.completedAt) : task.completedAt !== null)) throw new Error('任务完成状态或时间记录无效');
    ids.add(task.id);
  }
  const plans = new Set<string>();
  for (const plan of snapshot.plans) {
    assertKnown(plan, ['taskId', 'date', 'sortOrder']);
    const key = JSON.stringify([plan.taskId, plan.date]);
    if (!ids.has(plan.taskId) || !validDate(plan.date) || !Number.isSafeInteger(plan.sortOrder) || plan.sortOrder < 0 || plans.has(key)) throw new Error('计划引用、日期或顺序无效');
    plans.add(key);
  }
}
export function createEmptySnapshot(): Snapshot {
  const seed = createSeed();
  return { ...seed, tasks: [], plans: [] };
}
export function selectEarlierIncomplete(snapshot: Snapshot, today = localDate()): Task[] {
  const latest = new Map<string, string>();
  const plannedToday = new Set(snapshot.plans.filter(plan => plan.date === today).map(plan => plan.taskId));
  for (const plan of snapshot.plans) if (!latest.has(plan.taskId) || latest.get(plan.taskId)! < plan.date) latest.set(plan.taskId, plan.date);
  return snapshot.tasks.filter(task => !task.completed && latest.has(task.id) && latest.get(task.id)! < today && !plannedToday.has(task.id))
    .sort((a, b) => latest.get(b.id)!.localeCompare(latest.get(a.id)!) || a.id.localeCompare(b.id));
}
/** Browser preview adapter only. The desktop application executes these rules in Rust. */
export function applyPreviewAction(current: Snapshot, action: Action, expectedRevision: number): Snapshot {
  if (!validRevision(expectedRevision) || current.revision !== expectedRevision) throw new Error('内容已在另一窗口更新，请检查最新内容后重试。你的输入仍然保留。');
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('数据版本已超出安全范围');
  const next = normalizePreviewSnapshot(current);
  if (action.type === 'resetDemo') {
    if (!validDate(action.date)) throw new Error('日期格式无效');
    return { ...createSeed(action.date), settings: next.settings, revision: current.revision + 1 };
  }
  if (action.type === 'createTask') {
    assertKnown(action.task, [...taskFields, 'addToToday']);
    if (!validDate(action.date)) throw new Error('日期格式无效');
    if (typeof action.task.addToToday !== 'boolean') throw new Error('今日计划选项无效');
    const { addToToday, ...fields } = action.task;
    const created: Task = { ...fields, id: crypto.randomUUID(), completed: false, completedAt: null, createdAt: new Date().toISOString(), revision: 1 };
    if (typeof created.title === 'string') created.title = created.title.trim();
    fixDeadline(created);
    validateTask(created);
    next.tasks.push(created);
    if (addToToday) next.plans.push({ taskId: created.id, date: action.date, sortOrder: next.plans.length });
  } else if (action.type === 'updateSettings') {
    assertKnown(action.changes, settingsFields);
    next.settings = { ...next.settings, ...action.changes };
    validateSettings(next.settings);
  } else {
    const task = next.tasks.find(item => item.id === action.id);
    if (!task) throw new Error('这个任务已不存在，请刷新后重试');
    if (action.type === 'planTask') {
      if (!validDate(action.date) || typeof action.planned !== 'boolean') throw new Error('计划日期或选项无效');
      const exists = next.plans.some(plan => plan.taskId === task.id && plan.date === action.date);
      if (action.planned && !exists) next.plans.push({ taskId: task.id, date: action.date, sortOrder: next.plans.length });
      if (!action.planned) next.plans = next.plans.filter(plan => !(plan.taskId === task.id && plan.date === action.date));
    } else {
      if (!validRevision(action.expectedRevision) || task.revision !== action.expectedRevision) throw new Error('任务已更新，请检查最新内容后重试');
      if (action.type === 'updateTask') {
        assertKnown(action.changes, taskFields);
        const previous = { ...task };
        Object.assign(task, action.changes);
        if (typeof task.title === 'string') task.title = task.title.trim();
        fixDeadline(task, previous);
        validateTask(task);
        task.revision += 1;
      } else if (action.type === 'setCompleted') {
        if (typeof action.completed !== 'boolean') throw new Error('完成状态无效');
        if (task.completed !== action.completed) {
          task.completed = action.completed;
          task.completedAt = action.completed ? new Date().toISOString() : null;
          task.revision += 1;
        }
      } else throw new Error('无法识别操作');
    }
  }
  next.revision += 1;
  validateSnapshot(next);
  return next;
}
