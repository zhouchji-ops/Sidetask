import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreviewAction,
  createEmptySnapshot,
  createSeed,
  dateOffset,
  effectiveDeadline,
  formatDue,
  isOverdue,
  isPlannedToday,
  indexSnapshot,
  localDate,
  normalizePreviewSnapshot,
  selectDeadlines,
  selectEarlierIncomplete,
  nextTimeBoundary,
  selectToday,
} from '../src/lib/domain';
import type { Action, Snapshot, Task } from '../src/lib/types';

const today = '2026-09-24';

function apply(snapshot: Snapshot, action: Action): Snapshot {
  return applyPreviewAction(snapshot, action, snapshot.revision);
}

function task(id: string, changes: Partial<Task> = {}): Task {
  return {
    id, title: id, notes: '', priority: 'normal', dueDate: today, dueTime: null,
    completed: false, completedAt: null, revision: 1, createdAt: '2026-09-01T00:00:00.000Z',
    ...changes,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Local noon keeps the browser adapter's local-calendar behavior deterministic in any host zone.
  vi.setSystemTime(new Date(`${today}T12:00:00`));
});

describe('indexed task projections and daily ordering', () => {
  it('keeps every task and stable plan order at 10k, without changing persisted objects', () => {
    const snapshot = createSeed(today);
    snapshot.tasks = Array.from({ length: 10000 }, (_, index) => task(`indexed-${index}`, { dueDate: index % 2 ? null : today }));
    snapshot.plans = snapshot.tasks.map((item, index) => ({ taskId: item.id, date: today, sortOrder: 9999 - index }));
    const before = structuredClone(snapshot);
    const view = indexSnapshot(snapshot);
    expect(view.active).toHaveLength(10000);
    expect(view.today).toHaveLength(10000);
    expect(view.todayIds.size).toBe(10000);
    expect(view.deadlineCount).toBe(5000);
    expect(view.today[0]).toBe(snapshot.tasks[9999]);
    expect(view.byId.get('indexed-0')).toBe(snapshot.tasks[0]);
    expect(snapshot).toEqual(before);
  });

  it('recomputes the same snapshot when the local day moves forward and backward', () => {
    const snapshot = createSeed(today);
    const before = structuredClone(snapshot);
    expect(indexSnapshot(snapshot).activeToday).toHaveLength(3);
    vi.setSystemTime(new Date('2026-09-25T00:00:00'));
    expect(indexSnapshot(snapshot).today).toHaveLength(0);
    expect(indexSnapshot(snapshot).earlier).toHaveLength(3);
    vi.setSystemTime(new Date(`${today}T12:00:00`));
    expect(indexSnapshot(snapshot).activeToday).toHaveLength(3);
    expect(indexSnapshot(snapshot).earlier).toHaveLength(0);
    expect(snapshot).toEqual(before);
  });

  it('rebuilds floating date-only ordering for a different local zone without changing fixed deadlines', () => {
    const snapshot = createSeed(today);
    snapshot.tasks = [task('fixed', { dueTimezone: 'UTC' }), task('floating')];
    snapshot.plans = [];
    expect(selectDeadlines(snapshot, 'Asia/Shanghai').map(item => item.id)).toEqual(['floating', 'fixed']);
    expect(selectDeadlines(snapshot, 'America/New_York').map(item => item.id)).toEqual(['fixed', 'floating']);
    expect(snapshot.tasks[1].dueTimezone).toBeUndefined();
    expect(snapshot.tasks[0].dueTimezone).toBe('UTC');
  });

  it('reorders only active plans on the requested day and preserves task records, DDL and history', () => {
    const snapshot = createSeed(today);
    snapshot.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 99 });
    const before = structuredClone(snapshot);
    const taskIds = ['demo-paper', 'demo-read', 'demo-design'];
    const changed = apply(snapshot, { type: 'reorderToday', date: today, taskIds });
    expect(indexSnapshot(changed).activeToday.map(item => item.id)).toEqual(taskIds);
    expect(changed.tasks).toEqual(before.tasks);
    expect(changed.plans.find(plan => plan.taskId === 'demo-review')).toEqual(before.plans.find(plan => plan.taskId === 'demo-review'));
    expect(changed.plans.at(-1)).toEqual(before.plans.at(-1));
    expect(changed.revision).toBe(before.revision + 1);
    expect(selectDeadlines(changed)).toEqual(selectDeadlines(before));
    expect(snapshot).toEqual(before);
  });

  it.each([
    ['demo-paper', 'demo-read'],
    ['demo-paper', 'demo-read', 'demo-read'],
    ['demo-paper', 'demo-read', 'demo-review'],
    ['demo-paper', 'demo-read', 'demo-lab'],
  ])('rejects incomplete, duplicate, completed or unplanned reorder IDs atomically: %j', (...taskIds) => {
    const snapshot = createSeed(today);
    const before = structuredClone(snapshot);
    expect(() => apply(snapshot, { type: 'reorderToday', date: today, taskIds })).toThrow('重新排序');
    expect(snapshot).toEqual(before);
  });

  it('rejects stale reorder requests and invalid dates before updating the order', () => {
    const snapshot = createSeed(today);
    const taskIds = indexSnapshot(snapshot).activeToday.map(item => item.id);
    const changed = apply(snapshot, { type: 'setCompleted', id: taskIds[0], completed: true, expectedRevision: 1 });
    expect(() => applyPreviewAction(changed, { type: 'reorderToday', date: today, taskIds }, snapshot.revision)).toThrow('另一窗口');
    expect(() => apply(snapshot, { type: 'reorderToday', date: '2026-02-30', taskIds })).toThrow('计划日期');
  });
});
afterEach(() => vi.useRealTimers());

describe('single task identity across daily plans and deadlines', () => {
  it('appends a rejoined task after reordering and removing a plan, keeping history and task data', () => {
    const initial = createSeed(today);
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 99 });
    const reordered = apply(initial, { type: 'reorderToday', date: today, taskIds: ['demo-paper', 'demo-read', 'demo-design'] });
    const removed = apply(reordered, { type: 'planTask', id: 'demo-paper', date: today, planned: false });
    const joined = apply(removed, { type: 'planTask', id: 'demo-paper', date: today, planned: true });
    expect(indexSnapshot(joined).activeToday.map(item => item.id)).toEqual(['demo-read', 'demo-design', 'demo-paper']);
    expect(joined.tasks).toEqual(initial.tasks);
    expect(joined.plans.filter(plan => plan.date !== today)).toEqual(initial.plans.filter(plan => plan.date !== today));
    const plans = joined.plans.filter(plan => plan.date === today);
    expect(new Set(plans.map(plan => plan.sortOrder)).size).toBe(plans.length);
  });

  it.each([
    [0, 2, 4, 9],
    [7, 7, 7, 7],
    [Number.MAX_SAFE_INTEGER - 3, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
  ])('new and existing tasks append after gaps/ties/extreme orders %j %j %j %j', (...orders) => {
    for (const create of [false, true]) {
      const initial = createSeed(today);
      initial.plans.forEach((plan, index) => { plan.sortOrder = orders[index]; });
      initial.plans.push({ taskId: 'demo-lab', date: '2026-09-23', sortOrder: Number.MAX_SAFE_INTEGER });
      initial.plans.push({ taskId: 'demo-design', date: '2026-09-25', sortOrder: 77 });
      const before = structuredClone(initial);
      const expected = selectToday(initial).map(item => item.id);
      const changed = apply(initial, create
        ? { type: 'createTask', date: today, task: { title: '追加合成任务', notes: '', priority: 'normal', dueDate: null, dueTime: null, addToToday: true } }
        : { type: 'planTask', id: 'demo-lab', date: today, planned: true });
      const appended = create ? changed.tasks.at(-1)!.id : 'demo-lab';
      expect(selectToday(changed).map(item => item.id)).toEqual([...expected, appended]);
      expect(changed.plans.filter(plan => plan.date === today).map(plan => plan.sortOrder).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
      expect(changed.tasks.slice(0, initial.tasks.length)).toEqual(initial.tasks);
      expect(changed.plans.filter(plan => plan.date !== today)).toEqual(initial.plans.filter(plan => plan.date !== today));
      expect(apply(changed, { type: 'planTask', id: appended, date: today, planned: true }).plans).toEqual(changed.plans);
      expect(initial).toEqual(before);
    }
  });

  it('joining today twice creates only one reference and preserves the task and deadline', () => {
    const initial = createSeed(today);
    const existing = structuredClone(initial.tasks.find(item => item.id === 'demo-lab')!);
    const once = apply(initial, { type: 'planTask', id: existing.id, date: today, planned: true });
    const twice = apply(once, { type: 'planTask', id: existing.id, date: today, planned: true });

    expect(twice.tasks).toHaveLength(initial.tasks.length);
    expect(twice.tasks.find(item => item.id === existing.id)).toEqual(existing);
    expect(twice.plans.filter(plan => plan.taskId === existing.id && plan.date === today)).toHaveLength(1);
    expect(selectToday(twice).find(item => item.id === existing.id)).toBe(twice.tasks.find(item => item.id === existing.id));
    expect(selectDeadlines(twice).find(item => item.id === existing.id)).toBe(twice.tasks.find(item => item.id === existing.id));
  });

  it('completing and reopening updates the same record in both projections', () => {
    const initial = createSeed(today);
    const id = 'demo-design';
    const done = apply(initial, { type: 'setCompleted', id, completed: true, expectedRevision: 1 });

    expect(selectToday(done).find(item => item.id === id)?.completed).toBe(true);
    expect(selectDeadlines(done).some(item => item.id === id)).toBe(false);
    expect(done.tasks.find(item => item.id === id)?.completedAt).toBe(new Date().toISOString());
    const reopened = apply(done, { type: 'setCompleted', id, completed: false, expectedRevision: 2 });
    expect(selectToday(reopened).find(item => item.id === id)?.completed).toBe(false);
    expect(selectDeadlines(reopened).some(item => item.id === id)).toBe(true);
    expect(reopened.tasks.find(item => item.id === id)?.completedAt).toBeNull();
    expect(reopened.plans).toEqual(initial.plans);
    expect(initial.tasks.find(item => item.id === id)?.completed).toBe(false);
  });

  it('a repeated completion preserves the original completion time', () => {
    const initial = createSeed(today);
    const completed = apply(initial, { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 1 });
    const firstTime = completed.tasks.find(item => item.id === 'demo-design')!.completedAt;
    vi.advanceTimersByTime(10_000);
    const again = apply(completed, { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 2 });
    expect(again.tasks.find(item => item.id === 'demo-design')!.completedAt).toBe(firstTime);
  });

  it('removing from today retains the task, deadline, status, and historical plan', () => {
    const initial = createSeed(today);
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 0 });
    const next = apply(initial, { type: 'planTask', id: 'demo-design', planned: false, date: today });
    expect(isPlannedToday(next, 'demo-design')).toBe(false);
    expect(next.tasks).toEqual(initial.tasks);
    expect(selectDeadlines(next).map(item => item.id)).toContain('demo-design');
    expect(next.plans).toContainEqual({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 0 });
  });

  it('creating an un-dated today task does not manufacture a deadline', () => {
    const initial = createSeed(today);
    const next = apply(initial, {
      type: 'createTask', date: today,
      task: { title: '  完成课程学习  ', notes: '独立任务', priority: 'normal', dueDate: null, dueTime: null, addToToday: true },
    });
    const created = next.tasks.at(-1)!;
    expect(created.title).toBe('完成课程学习');
    expect(created.dueDate).toBeNull();
    expect(selectToday(next).map(item => item.id)).toContain(created.id);
    expect(selectDeadlines(next).map(item => item.id)).not.toContain(created.id);
  });

  it('crossing midnight changes the today projection without deleting or changing tasks', () => {
    const initial = createSeed(today);
    const before = structuredClone(initial);
    vi.setSystemTime(new Date('2026-09-25T00:00:00'));
    expect(selectToday(initial)).toEqual([]);
    expect(initial).toEqual(before);
    expect(initial.plans).toHaveLength(4);
    expect(initial.tasks.find(item => item.id === 'demo-design')!.completed).toBe(false);
  });
});

describe('stale edits and atomic validation', () => {
  it('rejects a stale global snapshot before changing any content', () => {
    const initial = createSeed(today);
    const changed = apply(initial, { type: 'updateSettings', changes: { theme: 'dark' } });
    const before = structuredClone(changed);
    expect(() => applyPreviewAction(changed, { type: 'planTask', id: 'demo-lab', date: today, planned: true }, initial.revision)).toThrow('另一窗口');
    expect(changed).toEqual(before);
  });

  it('rejects a stale task edit even when the global revision is current', () => {
    const initial = createSeed(today);
    const changed = apply(initial, { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 1 });
    const before = structuredClone(changed);
    expect(() => apply(changed, { type: 'updateTask', id: 'demo-design', changes: { title: '过期草稿' }, expectedRevision: 1 })).toThrow('任务已更新');
    expect(changed).toEqual(before);
  });

  it.each([
    [{ title: '  ' }, '标题'],
    [{ title: '字'.repeat(241) }, '240'],
    [{ dueDate: '2026-02-30' }, '截止日期'],
    [{ dueDate: null, dueTime: '12:00' }, '截止时间'],
    [{ dueTime: '24:00' }, '截止时间'],
  ])('rejects invalid task fields atomically: %j', (changes, message) => {
    const initial = createSeed(today);
    const before = structuredClone(initial);
    expect(() => apply(initial, { type: 'updateTask', id: 'demo-design', changes, expectedRevision: 1 })).toThrow(message);
    expect(initial).toEqual(before);
  });

  it('rejects a missing task and out-of-range window settings', () => {
    const initial = createSeed(today);
    expect(() => apply(initial, { type: 'planTask', id: 'missing', date: today, planned: true })).toThrow('不存在');
    expect(() => apply(initial, { type: 'updateSettings', changes: { panelWidth: 299 } })).toThrow('尺寸');
    expect(() => apply(initial, { type: 'updateSettings', changes: { hideDelay: 99 } })).toThrow('延迟');
    expect(initial.settings.panelWidth).toBe(368);
  });

  it('restoring synthetic examples resets content while advancing the snapshot version', () => {
    const initial = createSeed(today);
    const changed = apply(initial, { type: 'updateTask', id: 'demo-design', changes: { title: '临时测试内容' }, expectedRevision: 1 });
    const restored = apply(changed, { type: 'resetDemo', date: today });
    expect(restored.revision).toBe(changed.revision + 1);
    expect(restored.tasks).toEqual(createSeed(today).tasks);
    expect(restored.plans).toEqual(createSeed(today).plans);
    expect(changed.tasks[0].title).toBe('临时测试内容');
  });
});

describe('deadline calendar boundaries and stable ordering', () => {
  it('date-only deadlines expire at the next local midnight, while keeping the chosen date in the label', () => {
    const item = task('date-only');
    expect(isOverdue(item, new Date(`${today}T23:59:59.999`).getTime())).toBe(false);
    expect(isOverdue(item, new Date('2026-09-25T00:00:00').getTime())).toBe(true);
    expect(effectiveDeadline(item)).toBe(new Date('2026-09-25T00:00:00').getTime());
    expect(formatDue(item)).toBe('今天');
  });

  it('a precise deadline expires exactly at its chosen instant; completed tasks are not overdue', () => {
    const item = task('time', { dueTime: '18:30' });
    const at = new Date(`${today}T18:30:00`).getTime();
    expect(isOverdue(item, at - 1)).toBe(false);
    expect(isOverdue(item, at)).toBe(true);
    expect(isOverdue({ ...item, completed: true }, at + 1)).toBe(false);
    expect(isOverdue(task('without', { dueDate: null }), at)).toBe(false);
  });

  it('uses calendar-day arithmetic across month and leap-year boundaries', () => {
    expect(dateOffset('2026-09-30', 1)).toBe('2026-10-01');
    expect(dateOffset('2028-02-28', 1)).toBe('2028-02-29');
    expect(dateOffset('2026-01-01', -1)).toBe('2025-12-31');
    expect(localDate()).toBe(today);
  });

  it('date sorting honors effective deadlines, then creation time and ID, and leaves today order untouched', () => {
    const snapshot = createSeed(today);
    snapshot.tasks = [
      task('z-date'), task('b-time', { dueTime: '18:00' }),
      task('a-time', { dueTime: '18:00' }),
      task('old-time', { dueTime: '18:00', createdAt: '2026-08-01T00:00:00.000Z' }),
      task('no-date', { dueDate: null }), task('completed', { completed: true }),
    ];
    snapshot.plans = ['z-date', 'b-time', 'a-time'].map((taskId, sortOrder) => ({ taskId, date: today, sortOrder }));
    expect(selectDeadlines(snapshot).map(item => item.id)).toEqual(['old-time', 'a-time', 'b-time', 'z-date']);
    expect(selectToday(snapshot).map(item => item.id)).toEqual(['z-date', 'b-time', 'a-time']);
    expect(snapshot.tasks.map(item => item.id)).toEqual(['z-date', 'b-time', 'a-time', 'old-time', 'no-date', 'completed']);
  });

  it('priority sorting uses high → normal → low and then the same date tie-breakers', () => {
    const snapshot = createSeed(today);
    snapshot.settings.ddlSort = 'priority';
    snapshot.tasks = [
      task('low-early', { priority: 'low', dueDate: '2026-09-20' }),
      task('normal-early', { dueDate: '2026-09-21' }),
      task('high-late-b', { priority: 'high', dueDate: '2026-09-30' }),
      task('high-early', { priority: 'high', dueDate: '2026-09-29' }),
      task('high-late-a', { priority: 'high', dueDate: '2026-09-30' }),
    ];
    expect(selectDeadlines(snapshot).map(item => item.id)).toEqual(['high-early', 'high-late-a', 'high-late-b', 'normal-early', 'low-early']);
  });
});

describe('appearance preferences preserve task data', () => {
  it.each(['paper', 'studio', 'editorial', 'mono'] as const)('selecting %s preserves task identity, plans, theme and window preferences', (uiStyle) => {
    const initial = createSeed(today);
    initial.settings.theme = 'dark';
    initial.settings.panelWidth = 420;
    initial.settings.edge = 'left';
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 3 });
    const before = structuredClone(initial);
    const changed = apply(initial, { type: 'updateSettings', changes: { uiStyle } });
    expect(changed.tasks).toEqual(before.tasks);
    expect(changed.plans).toEqual(before.plans);
    expect(changed.settings).toEqual({ ...before.settings, uiStyle });
    expect(changed.revision).toBe(before.revision + 1);
    expect(initial).toEqual(before);
  });

  it('rejects an unknown style atomically', () => {
    const initial = createSeed(today);
    const before = structuredClone(initial);
    const action = { type: 'updateSettings', changes: { uiStyle: 'invalid-style' } } as unknown as Action;
    expect(() => apply(initial, action)).toThrow();
    expect(initial).toEqual(before);
  });

  it('adds the paper default to a legacy snapshot without replacing existing content or mutating the input', () => {
    const initial = createSeed(today);
    initial.revision = 41;
    initial.tasks[0].title = '旧版本数据需要完整保留';
    initial.settings.theme = 'dark';
    initial.settings.panelWidth = 420;
    const legacy = structuredClone(initial) as Omit<Snapshot, 'settings'> & { settings: Record<string, unknown> };
    delete legacy.settings.uiStyle;
    const before = structuredClone(legacy);
    const normalized = normalizePreviewSnapshot(legacy);
    expect(normalized).toEqual({ ...before, settings: { ...before.settings, uiStyle: 'paper' } });
    expect(legacy).toEqual(before);
    expect(normalizePreviewSnapshot(normalized)).toEqual(normalized);
  });
});

describe('edge panel split preference', () => {
  it('uses the existing 54 percent layout for both new empty data and preview examples', () => {
    expect(createSeed(today).settings.panelSplit).toBe(54);
    expect(createEmptySnapshot().settings.panelSplit).toBe(54);
  });

  it('saves boundary values without changing tasks, trash, DDL, plans or other settings', () => {
    const initial = createSeed(today);
    initial.tasks[0].deletedAt = '2026-09-24T00:00:00.000000001Z';
    initial.tasks[3].completedAt = '2026-09-23T03:04:05.000000123Z';
    initial.tasks[4] = task('demo-lab', { dueDate: '2026-11-01', dueTime: '01:30', dueTimezone: 'America/New_York', dueAtUtc: '2026-11-01T06:30:00.000000123Z' });
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 99 }, { taskId: 'demo-lab', date: '2026-09-26', sortOrder: 7 });
    initial.settings = { ...initial.settings, edge: 'left', panelWidth: 420, panelHeight: 700, theme: 'dark', uiStyle: 'editorial', ddlSort: 'priority', pinned: true };
    const before = structuredClone(initial);
    for (const panelSplit of [30, 54, 70]) {
      const changed = apply(initial, { type: 'updateSettings', changes: { panelSplit } });
      expect(changed).toEqual({ ...before, revision: before.revision + 1, settings: { ...before.settings, panelSplit } });
      expect(normalizePreviewSnapshot(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
      const rethemed = apply(changed, { type: 'updateSettings', changes: { theme: 'light' } });
      expect(rethemed.settings).toEqual({ ...changed.settings, theme: 'light' });
    }
    expect(initial).toEqual(before);
  });

  it('defaults missing legacy split and style fields without rewriting existing content', () => {
    for (const missingStyle of [false, true]) {
      const initial = createSeed(today);
      initial.revision = 41;
      initial.tasks[0].title = '旧版本任务与布局继续保留';
      initial.tasks[0].deletedAt = '2026-09-24T00:00:00Z';
      initial.settings.theme = 'dark';
      initial.settings.uiStyle = 'mono';
      const legacy = structuredClone(initial) as Omit<Snapshot, 'settings'> & { settings: Record<string, unknown> };
      delete legacy.settings.panelSplit;
      if (missingStyle) delete legacy.settings.uiStyle;
      const before = structuredClone(legacy);
      const normalized = normalizePreviewSnapshot(legacy);
      expect(normalized).toEqual({ ...before, settings: { ...before.settings, panelSplit: 54, uiStyle: missingStyle ? 'paper' : 'mono' } });
      const saved = apply(normalized, { type: 'updateSettings', changes: { panelSplit: 65 } });
      expect(saved.tasks).toEqual(initial.tasks);
      expect(saved.plans).toEqual(initial.plans);
      expect(saved.settings).toEqual({ ...normalized.settings, panelSplit: 65 });
      expect(legacy).toEqual(before);
      expect(normalizePreviewSnapshot(normalized)).toEqual(normalized);
    }
  });

  it('rejects fractional, empty, nonnumeric and out-of-range values on read and update atomically', () => {
    const initial = createSeed(today);
    const before = structuredClone(initial);
    for (const panelSplit of [29, 71, 54.5, null, '', '54', false, NaN, Infinity, -Infinity, {}, []]) {
      const action = { type: 'updateSettings', changes: { panelSplit, theme: 'dark' } } as unknown as Action;
      expect(() => apply(initial, action)).toThrow('分区比例');
      expect(initial).toEqual(before);
      const invalid = structuredClone(initial);
      Object.assign(invalid.settings, { panelSplit });
      const invalidBefore = structuredClone(invalid);
      expect(() => normalizePreviewSnapshot(invalid)).toThrow('分区比例');
      expect(invalid).toEqual(invalidBefore);
    }
    const clear = { type: 'updateSettings', changes: { panelSplit: undefined } } as unknown as Action;
    expect(() => apply(initial, clear)).toThrow('分区比例');
    expect(initial).toEqual(before);
  });
});

describe('strict persisted data and command boundaries', () => {
  it.each([
    ['invalid plan date', (s: Snapshot) => { s.plans[0].date = '2026-02-30'; }],
    ['dangling plan', (s: Snapshot) => { s.plans[0].taskId = 'missing'; }],
    ['duplicate plan', (s: Snapshot) => { s.plans.push({ ...s.plans[0] }); }],
    ['duplicate task ID', (s: Snapshot) => { s.tasks[1].id = s.tasks[0].id; }],
    ['unsafe revision', (s: Snapshot) => { s.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ['future task revision', (s: Snapshot) => { s.tasks[0].revision = 2; }],
    ['invalid completion', (s: Snapshot) => { s.tasks[0].completedAt = s.tasks[0].createdAt; }],
    ['invalid timestamp', (s: Snapshot) => { s.tasks[0].createdAt = '2026-02-30T00:00:00Z'; }],
    ['unknown field', (s: Snapshot) => { Object.assign(s.tasks[0], { parentId: 'unwanted' }); }],
    ['NaN size', (s: Snapshot) => { s.settings.panelWidth = NaN; }],
  ])('rejects %s on read without modifying the source', (_, corrupt) => {
    const snapshot = createSeed(today);
    corrupt(snapshot);
    const before = structuredClone(snapshot);
    expect(() => normalizePreviewSnapshot(snapshot)).toThrow();
    expect(snapshot).toEqual(before);
  });
  it.each([
    { type: 'planTask', id: 'demo-design', planned: true, date: '2026-02-30' },
    { type: 'updateTask', id: 'demo-design', expectedRevision: 1, changes: { priority: 'admin' } },
    { type: 'updateTask', id: 'demo-design', expectedRevision: 1, changes: { notes: '字'.repeat(10001) } },
    { type: 'updateTask', id: 'demo-design', expectedRevision: 1, changes: { id: 'overwrite' } },
    { type: 'updateTask', id: 'demo-design', expectedRevision: 1, changes: { dueAtUtc: '2026-01-01T00:00:00Z' } },
    { type: 'updateSettings', changes: { theme: 'invisible' } },
    { type: 'updateSettings', changes: { panelWidth: NaN } },
    { type: 'updateSettings', changes: { revealDelay: 1.5 } },
    { type: 'setCompleted', id: 'demo-design', expectedRevision: 1, completed: 'false' },
  ])('rejects malformed runtime input atomically: %j', action => {
    const initial = createSeed(today);
    const before = structuredClone(initial);
    expect(() => apply(initial, action as unknown as Action)).toThrow();
    expect(initial).toEqual(before);
  });
  it('accepts 240 Unicode code points consistently with Rust and rejects 241', () => {
    const initial = createSeed(today);
    const changed = apply(initial, { type: 'updateTask', id: 'demo-design', expectedRevision: 1, changes: { title: '😀'.repeat(240) } });
    expect(changed.tasks[0].title).toBe('😀'.repeat(240));
    expect(() => apply(changed, { type: 'updateTask', id: 'demo-design', expectedRevision: 2, changes: { title: '😀'.repeat(241) } })).toThrow('240');
  });
  it('does not increase an entity revision on repeated completion and refuses revision overflow', () => {
    const initial = createSeed(today);
    const once = apply(initial, { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 1 });
    const twice = apply(once, { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 2 });
    expect(twice.tasks[0].revision).toBe(2);
    twice.revision = Number.MAX_SAFE_INTEGER;
    expect(() => apply(twice, { type: 'updateSettings', changes: { theme: 'dark' } })).toThrow('安全范围');
  });
});

describe('fixed IANA deadline semantics', () => {
  const create = (date: string, time: string | null, zone = 'America/New_York') => {
    const snapshot = createSeed(today);
    return apply(snapshot, { type: 'createTask', date: today, task: { title: '固定时区', notes: '', priority: 'normal', dueDate: date, dueTime: time, dueTimezone: zone, addToToday: false } });
  };
  it('commits a precise UTC instant that remains unchanged by unrelated edits', () => {
    const initial = create('2026-09-24', '18:30', 'Asia/Shanghai');
    const item = initial.tasks.at(-1)!;
    expect(item.dueAtUtc).toBe('2026-09-24T10:30:00Z');
    expect(effectiveDeadline(item)).toBe(Date.parse('2026-09-24T10:30:00Z'));
    const changed = apply(initial, { type: 'updateTask', id: item.id, expectedRevision: 1, changes: { title: '改名称', dueDate: item.dueDate, dueTime: item.dueTime } });
    expect(changed.tasks.at(-1)!.dueAtUtc).toBe(item.dueAtUtc);
    expect(changed.tasks.at(-1)!.dueTimezone).toBe('Asia/Shanghai');
    expect(isOverdue(item, Date.parse(item.dueAtUtc!) - 1)).toBe(false);
    expect(isOverdue(item, Date.parse(item.dueAtUtc!))).toBe(true);
  });
  it.each([
    ['2026-03-08', '02:30'], ['2026-11-01', '01:30'],
  ])('rejects missing or repeated local time %s %s instead of drifting', (date, time) => {
    expect(() => create(date, time)).toThrow('夏令时');
  });
  it.each([
    ['2026-03-08', '2026-03-09T04:00:00Z', 23],
    ['2026-11-01', '2026-11-02T05:00:00Z', 25],
  ])('date-only %s expires at the next calendar day (%s), whose length is %s hours', (date, end, length) => {
    const item = create(date, null).tasks.at(-1)!;
    expect(item.dueAtUtc).toBeNull();
    expect(effectiveDeadline(item)).toBe(Date.parse(end));
    const previous = create(dateOffset(date, -1), null).tasks.at(-1)!;
    expect(effectiveDeadline(item) - effectiveDeadline(previous)).toBe(Number(length) * 60 * 60 * 1000);
  });
  it('handles a skipped midnight and a skipped calendar day explicitly', () => {
    const beforeSkippedMidnight = create('2018-11-03', null, 'America/Sao_Paulo').tasks.at(-1)!;
    expect(effectiveDeadline(beforeSkippedMidnight)).toBe(Date.parse('2018-11-04T03:00:00Z'));
    const beforeSkippedDay = create('2011-12-29', null, 'Pacific/Apia').tasks.at(-1)!;
    expect(effectiveDeadline(beforeSkippedDay)).toBe(Date.parse('2011-12-30T10:00:00Z'));
    expect(() => create('2011-12-30', null, 'Pacific/Apia')).toThrow('不存在');
  });
  it('keeps legacy deadline fields untouched on read or ordinary edits, and fixes them only after changing the DDL', () => {
    const initial = createSeed(today);
    const item = initial.tasks[0];
    const renamed = apply(initial, { type: 'updateTask', id: item.id, expectedRevision: 1, changes: { title: '只有名字变了', dueDate: item.dueDate, dueTime: item.dueTime } });
    expect(renamed.tasks[0].dueTimezone).toBeUndefined();
    expect(renamed.tasks[0].dueAtUtc).toBeUndefined();
    const edited = apply(renamed, { type: 'updateTask', id: item.id, expectedRevision: 2, changes: { dueTime: '19:00', dueTimezone: 'Asia/Shanghai' } });
    expect(edited.tasks[0].dueAtUtc).toBe('2026-09-25T11:00:00Z');
    expect(edited.tasks[0].dueDate).toBe(item.dueDate);
    const cleared = apply(edited, { type: 'updateTask', id: item.id, expectedRevision: 3, changes: { dueDate: null, dueTime: null } });
    expect(cleared.tasks[0].dueTimezone).toBeNull();
    expect(cleared.tasks[0].dueAtUtc).toBeNull();
  });
  it('rejects inconsistent fixed metadata and does not permit offset-only time zones', () => {
    expect(() => create(today, '18:30', '+08:00')).toThrow('时区');
    const snapshot = create(today, '18:30');
    delete snapshot.tasks.at(-1)!.dueAtUtc;
    expect(() => normalizePreviewSnapshot(snapshot)).toThrow('UTC');
  });
  it('uses fixed-zone calendar today for date-only labels, and local display time for precise instants', () => {
    vi.setSystemTime(new Date('2026-09-24T01:00:00Z'));
    const snapshot = create('2026-09-23', null, 'America/Los_Angeles');
    const item = snapshot.tasks.at(-1)!;
    expect(formatDue(item)).toContain('今天');
    expect(item.dueDate).toBe('2026-09-23');
  });
  it('orders equal UTC instants by parsed creation instant rather than timestamp spelling', () => {
    const snapshot = createSeed(today);
    snapshot.tasks = [
      task('a', { dueAtUtc: '2026-09-24T10:00:00Z', dueTimezone: 'Asia/Shanghai', dueTime: '18:00', createdAt: '2026-09-01T00:00:00+00:00' }),
      task('b', { dueAtUtc: '2026-09-24T10:00:00Z', dueTimezone: 'America/New_York', dueTime: '06:00', createdAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(selectDeadlines(snapshot).map(item => item.id)).toEqual(['a', 'b']);
  });
});


describe('derived time boundaries and earlier unfinished plans', () => {
  it('finds the nearest precise instant without touching a task or revision', () => {
    const snapshot = createSeed(today);
    const before = structuredClone(snapshot);
    const next = nextTimeBoundary(snapshot.tasks);
    expect(next).toBeGreaterThan(Date.now());
    const soon = task('soon', { dueAtUtc: new Date(Date.now() + 500).toISOString(), dueTimezone: 'UTC', dueTime: '00:00' });
    expect(nextTimeBoundary([...snapshot.tasks, soon])).toBe(Date.now() + 500);
    expect(snapshot).toEqual(before);
  });
  it('keeps each unfinished historical task once and brings it back after removing today', () => {
    const initial = createSeed(today);
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 0 });
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-22', sortOrder: 0 });
    expect(selectEarlierIncomplete(initial).map(task => task.id)).not.toContain('demo-design');
    const removed = apply(initial, { type: 'planTask', id: 'demo-design', planned: false, date: today });
    expect(selectEarlierIncomplete(removed).map(task => task.id)).toEqual(['demo-design']);
    vi.setSystemTime(new Date('2026-09-25T00:00:00'));
    expect(selectEarlierIncomplete(removed).map(task => task.id).sort()).toEqual(['demo-design', 'demo-paper', 'demo-read']);
    expect(removed.tasks).toEqual(initial.tasks);
  });
});

it('preserves nanosecond creation ordering and never expires an imported sub-millisecond instant early', () => {
  const snapshot = createSeed(today);
  snapshot.tasks = [
    task('a-later', { dueTime: '18:00', createdAt: '2026-09-01T00:00:00.000000002Z' }),
    task('z-earlier', { dueTime: '18:00', createdAt: '2026-09-01T00:00:00.000000001Z' }),
  ];
  expect(selectDeadlines(snapshot).map(item => item.id)).toEqual(['z-earlier', 'a-later']);
  const at = task('precise-import', { dueTime: '18:00', dueTimezone: 'UTC', dueAtUtc: '2026-09-24T18:00:00.000000001Z' });
  const millisecond = Date.parse('2026-09-24T18:00:00Z');
  expect(isOverdue(at, millisecond)).toBe(false);
  expect(isOverdue(at, millisecond + 1)).toBe(true);
});


it('does not mark a task with a later planned date as previously unfinished after a clock rollback', () => {
  const snapshot = createSeed(today);
  snapshot.plans = [
    { taskId: 'demo-design', date: '2026-09-23', sortOrder: 0 },
    { taskId: 'demo-design', date: '2026-09-25', sortOrder: 0 },
  ];
  expect(selectEarlierIncomplete(snapshot, today)).toEqual([]);
  expect(selectEarlierIncomplete(snapshot, '2026-09-26').map(task => task.id)).toEqual(['demo-design']);
});

describe('recoverable task lifecycle', () => {
  it.each([false, true])('trashes and restores completed=%s without changing task content, fixed DDL or any plan', completed => {
    const snapshot = createSeed(today);
    snapshot.tasks[0] = task('demo-design', {
      title: '保留原任务', notes: '包含历史和未来计划', priority: 'high', completed,
      completedAt: completed ? '2026-09-02T03:04:05.000000123Z' : null,
      createdAt: '2026-09-01T03:04:05.000000001Z',
      dueDate: '2026-11-01', dueTime: '01:30', dueTimezone: 'America/New_York',
      dueAtUtc: '2026-11-01T06:30:00.000000123Z',
    });
    snapshot.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 9 }, { taskId: 'demo-design', date: '2026-09-26', sortOrder: 7 });
    const before = structuredClone(snapshot);
    const deleted = apply(snapshot, { type: 'trashTask', id: 'demo-design', expectedRevision: 1 });
    expect(deleted.tasks[0]).toEqual({ ...before.tasks[0], deletedAt: new Date().toISOString(), revision: 2 });
    expect(indexSnapshot(deleted).byId.get('demo-design')).toBe(deleted.tasks[0]);
    expect(isPlannedToday(deleted, 'demo-design')).toBe(false);
    expect(deleted.plans).toEqual(before.plans);
    const restored = apply(deleted, { type: 'restoreTask', id: 'demo-design', expectedRevision: 2 });
    expect(restored.tasks[0]).toEqual({ ...before.tasks[0], deletedAt: null, revision: 3 });
    expect(restored.tasks.slice(1)).toEqual(before.tasks.slice(1));
    expect(restored.plans).toEqual(before.plans);
    expect(isPlannedToday(restored, 'demo-design')).toBe(true);
    expect(effectiveDeadline(restored.tasks[0])).toBe(effectiveDeadline(before.tasks[0]));
    expect(restored.revision).toBe(before.revision + 2);
    expect(snapshot).toEqual(before);
  });

  it('keeps repeated lifecycle requests idempotent after revision checks, including missing legacy markers', () => {
    const initial = createSeed(today);
    const unchanged = apply(initial, { type: 'restoreTask', id: 'demo-design', expectedRevision: 1 });
    expect(unchanged.tasks).toEqual(initial.tasks);
    expect(unchanged.tasks[0]).not.toHaveProperty('deletedAt');
    const deleted = apply(unchanged, { type: 'trashTask', id: 'demo-design', expectedRevision: 1 });
    vi.advanceTimersByTime(60_000);
    const repeated = apply(deleted, { type: 'trashTask', id: 'demo-design', expectedRevision: 2 });
    expect(repeated.tasks).toEqual(deleted.tasks);
    expect(repeated.plans).toEqual(deleted.plans);
    expect(repeated.revision).toBe(deleted.revision + 1);
    expect(() => apply(repeated, { type: 'trashTask', id: 'demo-design', expectedRevision: 1 })).toThrow('任务已更新');
    const restored = apply(repeated, { type: 'restoreTask', id: 'demo-design', expectedRevision: 2 });
    expect(apply(restored, { type: 'restoreTask', id: 'demo-design', expectedRevision: 3 }).tasks).toEqual(restored.tasks);
  });

  it('rejects stale deletion, restoration and old undo after another delete cycle atomically', () => {
    const initial = createSeed(today);
    const completed = apply(initial, { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 1 });
    expect(() => apply(completed, { type: 'trashTask', id: 'demo-design', expectedRevision: 1 })).toThrow('任务已更新');
    expect(() => applyPreviewAction(completed, { type: 'trashTask', id: 'demo-design', expectedRevision: 2 }, initial.revision)).toThrow('另一窗口');
    const deleted = apply(completed, { type: 'trashTask', id: 'demo-design', expectedRevision: 2 });
    const restored = apply(deleted, { type: 'restoreTask', id: 'demo-design', expectedRevision: 3 });
    const deletedAgain = apply(restored, { type: 'trashTask', id: 'demo-design', expectedRevision: 4 });
    const before = structuredClone(deletedAgain);
    expect(() => apply(deletedAgain, { type: 'restoreTask', id: 'demo-design', expectedRevision: 3 })).toThrow('任务已更新');
    expect(deletedAgain).toEqual(before);
  });

  it.each([
    { type: 'updateTask', id: 'demo-design', changes: { title: '不能覆盖' }, expectedRevision: 2 },
    { type: 'setCompleted', id: 'demo-design', completed: true, expectedRevision: 2 },
    { type: 'planTask', id: 'demo-design', date: today, planned: true },
    { type: 'planTask', id: 'demo-design', date: today, planned: false },
  ] as Action[])('rejects ordinary mutations on a trashed task: $type', action => {
    const deleted = apply(createSeed(today), { type: 'trashTask', id: 'demo-design', expectedRevision: 1 });
    const before = structuredClone(deleted);
    expect(() => apply(deleted, action)).toThrow('请先恢复');
    expect(deleted).toEqual(before);
  });

  it('filters every normal projection while retaining all IDs and deleted task records', () => {
    const snapshot = createSeed(today);
    snapshot.tasks[0].deletedAt = '2026-09-24T01:00:00Z';
    snapshot.tasks[3].deletedAt = '2026-09-24T02:00:00Z';
    snapshot.tasks[4].deletedAt = '2026-09-24T03:00:00Z';
    snapshot.plans.push({ taskId: 'demo-lab', date: '2026-09-23', sortOrder: 0 }, { taskId: 'demo-portfolio', date: '2026-09-23', sortOrder: 1 });
    const before = structuredClone(snapshot);
    const view = indexSnapshot(snapshot);
    expect(view.byId.size).toBe(6);
    expect(view.visibleTasks.map(task => task.id)).toEqual(['demo-read', 'demo-paper', 'demo-portfolio']);
    expect(view.active).toEqual(view.visibleTasks);
    expect(view.completed).toEqual([]);
    expect(view.today.map(task => task.id)).toEqual(['demo-read', 'demo-paper']);
    expect([...view.todayIds]).toEqual(['demo-read', 'demo-paper']);
    expect(view.activeToday).toEqual(view.today);
    expect(view.completedToday).toEqual([]);
    expect(view.earlier.map(task => task.id)).toEqual(['demo-portfolio']);
    expect(view.deadlineCount).toBe(2);
    expect(selectDeadlines(snapshot).map(task => task.id)).toEqual(['demo-paper', 'demo-portfolio']);
    expect(view.trashed.map(task => task.id)).toEqual(['demo-lab', 'demo-review', 'demo-design']);
    expect(snapshot).toEqual(before);
  });

  it('sorts trash by exact deletion instant descending, with stable IDs for equivalent timestamp spellings', () => {
    const snapshot = createSeed(today);
    snapshot.tasks = [
      task('old', { deletedAt: '2026-09-24T00:00:00.000000001Z' }),
      task('b-tie', { deletedAt: '2026-09-24T00:00:00.000000002+00:00' }),
      task('z-new', { deletedAt: '2026-09-24T00:00:00.000000003Z' }),
      task('a-tie', { deletedAt: '2026-09-24T00:00:00.000000002Z' }),
    ];
    snapshot.plans = [];
    const view = indexSnapshot(normalizePreviewSnapshot(snapshot));
    expect(view.trashed.map(task => task.id)).toEqual(['z-new', 'a-tie', 'b-tie', 'old']);
    expect(view.visibleTasks).toEqual([]);
    expect(view.active).toEqual([]);
    expect(view.completed).toEqual([]);
    expect(view.deadlineCount).toBe(0);
  });

  it('restores historical, future and unplanned tasks across midnight without adding today plans', () => {
    let snapshot = createSeed(today);
    snapshot.tasks = [task('past'), task('future'), task('unplanned')];
    snapshot.plans = [{ taskId: 'past', date: today, sortOrder: 8 }, { taskId: 'future', date: '2026-09-26', sortOrder: 2 }];
    const plans = structuredClone(snapshot.plans);
    for (const item of snapshot.tasks) snapshot = apply(snapshot, { type: 'trashTask', id: item.id, expectedRevision: 1 });
    vi.setSystemTime(new Date('2026-09-25T12:00:00'));
    for (const item of snapshot.tasks) snapshot = apply(snapshot, { type: 'restoreTask', id: item.id, expectedRevision: 2 });
    expect(indexSnapshot(snapshot).today).toEqual([]);
    expect(indexSnapshot(snapshot).earlier.map(task => task.id)).toEqual(['past']);
    expect(indexSnapshot(snapshot).active).toHaveLength(3);
    expect(snapshot.plans).toEqual(plans);
    expect(snapshot.tasks.every(task => task.dueDate === today && !task.completed)).toBe(true);
  });

  it.each([1, Number.MAX_SAFE_INTEGER])('keeps hidden plan order %s during visible reorder and append, then restores without moving plans', hiddenOrder => {
    const initial = createSeed(today);
    initial.plans[0].sortOrder = hiddenOrder;
    initial.plans.push({ taskId: 'demo-design', date: '2026-09-23', sortOrder: 99 });
    const deleted = apply(initial, { type: 'trashTask', id: 'demo-design', expectedRevision: 1 });
    expect(() => apply(deleted, { type: 'reorderToday', date: today, taskIds: ['demo-design', 'demo-paper', 'demo-read'] })).toThrow('重新排序');
    const reordered = apply(deleted, { type: 'reorderToday', date: today, taskIds: ['demo-paper', 'demo-read'] });
    for (const create of [false, true]) {
      const appended = apply(reordered, create
        ? { type: 'createTask', date: today, task: { title: '新增任务', notes: '', priority: 'normal', dueDate: null, dueTime: null, addToToday: true } }
        : { type: 'planTask', id: 'demo-lab', date: today, planned: true });
      const hidden = (s: Snapshot) => s.plans.filter(plan => plan.taskId === 'demo-design');
      expect(hidden(appended)).toEqual(hidden(initial));
      expect(indexSnapshot(appended).today.slice(0, 3).map(task => task.id)).toEqual(['demo-paper', 'demo-read', 'demo-review']);
      const restored = apply(appended, { type: 'restoreTask', id: 'demo-design', expectedRevision: 2 });
      expect(restored.plans).toEqual(appended.plans);
      const expected = [...restored.plans].filter(plan => plan.date === today).sort((a, b) => a.sortOrder - b.sortOrder).map(plan => plan.taskId);
      expect(selectToday(restored).map(task => task.id)).toEqual(expected);
    }
  });

  it('accepts old missing/null deletion markers without rewriting the preview snapshot', () => {
    const snapshot = createSeed(today);
    snapshot.tasks[1].deletedAt = null;
    const normalized = normalizePreviewSnapshot(snapshot);
    expect(normalized).toEqual(snapshot);
    expect(normalized.tasks[0]).not.toHaveProperty('deletedAt');
    expect(indexSnapshot(normalized).visibleTasks).toHaveLength(snapshot.tasks.length);
  });

  it.each(['', '2026-02-30T00:00:00Z', '2026-09-24T12:00:00+08:00', '2026-09-24T12:00:00', 0])('rejects invalid deletion timestamps without discarding preview data: %j', deletedAt => {
    const snapshot = createSeed(today);
    Object.assign(snapshot.tasks[0], { deletedAt });
    const before = structuredClone(snapshot);
    expect(() => normalizePreviewSnapshot(snapshot)).toThrow('删除时间');
    expect(snapshot).toEqual(before);
  });

  it('does not allow editing the lifecycle marker through ordinary task input', () => {
    const snapshot = createSeed(today);
    const action = { type: 'updateTask', id: 'demo-design', expectedRevision: 1, changes: { deletedAt: '2026-09-24T00:00:00Z' } } as unknown as Action;
    expect(() => apply(snapshot, action)).toThrow('不支持的字段');
    expect(snapshot.tasks[0]).not.toHaveProperty('deletedAt');
  });

  it('ignores trashed deadline instants and source-zone midnights while preserving their stored DDL', () => {
    vi.setSystemTime(new Date('2026-09-24T19:59:59Z'));
    const now = Date.now();
    const precise = task('precise', { dueTimezone: 'UTC', dueTime: '19:59', dueAtUtc: '2026-09-24T19:59:59.500000001Z', deletedAt: '2026-09-24T01:00:00Z' });
    const dateOnly = task('date', { dueDate: '2026-10-02', dueTimezone: 'Asia/Dubai', deletedAt: '2026-09-24T01:00:00Z' });
    const before = structuredClone([precise, dateOnly]);
    const localBoundary = nextTimeBoundary([], now);
    expect(nextTimeBoundary([precise, dateOnly], now)).toBe(localBoundary);
    expect(isOverdue(precise, now + 1000)).toBe(false);
    expect(formatDue(precise)).not.toContain('已逾期');
    const restored = { ...precise, deletedAt: null };
    expect(nextTimeBoundary([restored], now)).toBe(Math.min(localBoundary, now + 501));
    expect(isOverdue(restored, now + 500)).toBe(false);
    expect(isOverdue(restored, now + 501)).toBe(true);
    expect(nextTimeBoundary([{ ...dateOnly, deletedAt: null }], now)).toBe(Math.min(localBoundary, Date.parse('2026-09-24T20:00:00Z')));
    expect([precise, dateOnly]).toEqual(before);
  });
});

describe('edge panel reveal mode', () => {
  it('defaults new and legacy previews to click without rewriting legacy data', () => {
    expect(createEmptySnapshot().settings.revealMode).toBe('click');
    const current = createSeed(today);
    const { revealMode: _mode, ...settings } = current.settings;
    const legacy = { ...current, settings };
    const before = structuredClone(legacy);
    const normalized = normalizePreviewSnapshot(legacy);
    expect(normalized).toEqual({ ...legacy, settings: { ...settings, revealMode: 'click' } });
    expect(legacy).toEqual(before);
    expect(legacy.settings).not.toHaveProperty('revealMode');
  });

  it('persists either explicit mode and preserves it during unrelated preference and task updates', () => {
    let snapshot = createSeed(today);
    const tasks = structuredClone(snapshot.tasks);
    const plans = structuredClone(snapshot.plans);
    for (const revealMode of ['hover', 'click'] as const) {
      const before = structuredClone(snapshot);
      snapshot = apply(snapshot, { type: 'updateSettings', changes: { revealMode } });
      expect(snapshot).toEqual({ ...before, revision: before.revision + 1, settings: { ...before.settings, revealMode } });
      expect(() => applyPreviewAction(snapshot, { type: 'updateSettings', changes: { revealMode } }, before.revision)).toThrow();
      snapshot = normalizePreviewSnapshot(JSON.parse(JSON.stringify(snapshot)));
      snapshot = apply(snapshot, { type: 'updateSettings', changes: { pinned: true, revealDelay: 300, hideDelay: 800 } });
      expect(snapshot.settings.revealMode).toBe(revealMode);
      expect(snapshot.tasks).toEqual(tasks);
      expect(snapshot.plans).toEqual(plans);
    }
    const changed = apply(snapshot, { type: 'setCompleted', id: snapshot.tasks[0].id, completed: true, expectedRevision: snapshot.tasks[0].revision });
    expect(changed.settings).toEqual(snapshot.settings);
  });

  it.each(['', 'Hover', 'automatic', null, 0, false])('rejects invalid mode %j without changing stored state', revealMode => {
    const snapshot = createSeed(today);
    const before = structuredClone(snapshot);
    expect(() => apply(snapshot, { type: 'updateSettings', changes: { revealMode } } as unknown as Action)).toThrow('设置选项');
    expect(snapshot).toEqual(before);
    expect(() => normalizePreviewSnapshot({ ...snapshot, settings: { ...snapshot.settings, revealMode } })).toThrow('设置选项');
  });
});
