import { useState } from 'react';
import { Check, LoaderCircle, Palette } from 'lucide-react';
import { uiStyleOptions } from '../lib/appearance';
import type { UIStyle } from '../lib/types';

export function StylePicker({ value, busy, onChange }: { value: UIStyle; busy: boolean; onChange: (style: UIStyle) => Promise<void> }) {
  const [pending, setPending] = useState<UIStyle | null>(null);
  const [feedback, setFeedback] = useState('');
  const [failure, setFailure] = useState('');
  async function select(style: UIStyle) {
    if (style === value || busy || pending) return;
    setPending(style);
    setFailure('');
    setFeedback('');
    try {
      await onChange(style);
      setFeedback(`已切换到${uiStyleOptions.find(item => item.value === style)?.name}，并保存在本机`);
    } catch {
      setFailure('风格未能保存，已保留原来的外观。请重试。');
    } finally { setPending(null); }
  }
  return <section className="settings-section style-section" aria-labelledby="style-heading">
    <div className="style-section-heading">
      <div className="settings-section-title"><Palette size={18}/><h2 id="style-heading">界面风格</h2></div>
    </div>
    <p className="style-description">选择后自动保存，并同步到小窗。浅深色可单独设置。</p>
    <div className="style-options" role="group" aria-label="界面风格">
      {uiStyleOptions.map(item => <button key={item.value} type="button"
        className={`style-option ${value === item.value ? 'style-selected' : ''}`}
        aria-label={`切换到${item.name}风格`} aria-pressed={value === item.value}
        disabled={busy || pending !== null} onClick={() => void select(item.value)}>
        <span className={`style-preview preview-${item.value}`} aria-hidden="true">
          <span className="mini-console">
            <span className="mini-sidebar"><i className="mini-brand"/><i className="mini-nav active"/><i className="mini-nav"/><i className="mini-nav"/><i className="mini-sidebar-bottom"/></span>
            <span className="mini-page"><span className="mini-title">今日</span><span className="mini-task"><i/><b/></span><span className="mini-task"><i/><b/></span><span className="mini-task"><i/><b/></span><span className="mini-add">＋</span></span>
          </span>
          <span className="mini-panel"><span className="mini-panel-title">今日</span><span className="mini-task"><i/><b/></span><span className="mini-task"><i/><b/></span><span className="mini-panel-divider"/><span className="mini-panel-label">截止日期</span><span className="mini-task"><i/><b/></span></span>
        </span>
        <span className="style-option-label"><span>{item.name}</span><span className="style-selection-mark">{pending === item.value ? <LoaderCircle size={12} className="spin"/> : value === item.value ? <Check size={12}/> : null}</span></span>
        <span className="style-option-description">{item.subtitle}</span>
      </button>)}
    </div>
    <span className="sr-only" role="status">{feedback}</span>
    {failure && <p className="inline-error" role="alert">{failure}</p>}
  </section>;
}
