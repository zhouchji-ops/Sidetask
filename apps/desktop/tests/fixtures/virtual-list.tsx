import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskRow } from '../../src/components/TaskUI';
import { VirtualTaskList } from '../../src/components/VirtualTaskList';
import type { Task } from '../../src/lib/types';
import '../../src/styles/app.css';
import '../../src/styles/variants.css';

function Fixture() {
  const scrollRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [narrow, setNarrow] = useState(false);
  const [showTasks, setShowTasks] = useState(true);
  const [selected, setSelected] = useState('');
  const [tasks, setTasks] = useState<Task[]>(() => Array.from({ length: 10000 }, (_, index) => ({
    id: `task-${index}`, title: `第${String(index).padStart(5, '0')}项${index % 5 === 0 ? '中文长标题用于验证多行内容换行后仍能完整阅读且不会覆盖下一条任务'.repeat(5) : '合成任务'}`,
    notes: '', priority: 'normal', dueDate: null, dueTime: null, completed: false,
    completedAt: null, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', revision: 1,
  })));
  const filtered = useMemo(() => tasks.filter(task => task.title.includes(query)), [tasks, query]);
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    <header style={{ display: 'flex', gap: 12, padding: 12 }}>
      <input aria-label="筛选合成任务" value={query} onChange={event => setQuery(event.target.value)}/>
      <select aria-label="风格" onChange={event => { document.documentElement.dataset.style = event.target.value; }}><option value="paper">paper</option><option value="studio">studio</option><option value="editorial">editorial</option><option value="mono">mono</option></select>
      <button onClick={() => setNarrow(!narrow)}>切换宽度</button>
      <button onClick={() => setTasks(value => value.slice(10))}>移除列表前十项</button>
      <button onClick={() => setShowTasks(value => !value)}>切换任务页面</button>
      <output aria-label="选中任务">{selected}</output>
    </header>
    <main ref={scrollRef} className="main-content" style={{ width: narrow ? 370 : '100%', maxWidth: '100%' }}>
      <div style={{ minHeight: 135 }}><h1>合成大列表</h1><p>全量任务：{filtered.length}</p></div>
      {showTasks ? <VirtualTaskList items={filtered} scrollRef={scrollRef} resetKey={query} className="task-list" label="合成任务列表"
        renderItem={task => <TaskRow task={task} onSelect={() => setSelected(task.id)} onToggle={() => setTasks(value => value.filter(item => item.id !== task.id))}/>}/> : <div style={{ height: 5000 }}>合成设置页面</div>}
      <button style={{ marginTop: 20 }} onClick={() => setSelected('after')}>列表之后</button>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
