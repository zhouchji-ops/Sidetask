import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPreviewAction,
  createSeed,
  dateOffset,
  effectiveDeadline,
  formatDue,
  isOverdue,
  isPlannedToday,
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
afterEach(() => vi.useRealTimers());

describe('single task identity across daily plans and deadlines', () => {
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
