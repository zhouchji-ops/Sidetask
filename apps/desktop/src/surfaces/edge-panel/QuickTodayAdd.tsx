import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { Check, LoaderCircle, X } from 'lucide-react';
import { localDate } from '../../lib/domain';
import { useDraft } from '../../lib/drafts';
import { setInteractionLock, windowAction } from '../../lib/native';
import { useAppStore } from '../../lib/store';

export interface QuickTodayAddHandle { leave: (action: () => void) => void }

/** A draft belongs to this window; only committed tasks enter the shared store. */
export function QuickTodayAdd({ open, focusRequest, onClose, ref }: {
  open: boolean;
  focusRequest: number;
  onClose: () => void;
  ref: Ref<QuickTodayAddHandle>;
}) {
  const { mutate, busy, clearError } = useAppStore();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const owner = useRef(Symbol('quick-today-add'));
  const composing = useRef(false);
  const inFlight = useRef(false);
  const returnToInput = useRef(false);
  const pendingLeave = useRef<(() => void) | null>(null);
  const locked = busy || saving;

  useLayoutEffect(() => { if (confirmClose) continueButton.current?.focus(); }, [confirmClose]);

  useLayoutEffect(() => {
    if (locked || confirmClose || !returnToInput.current) return;
    returnToInput.current = false;
    const field = input.current;
    // Restore after React enables the input, and respect a deliberate move
    // outside the form during a slow write.
    if (field && (document.activeElement === document.body || field.form?.contains(document.activeElement))) field.focus();
  }, [locked, confirmClose]);

  useEffect(() => {
    if (!open) return;
    const key = owner.current;
    void setInteractionLock(true, key).catch(reason => setError(String(reason)));
    return () => { void setInteractionLock(false, key).catch(() => {}); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const previous = document.activeElement;
    const blur = () => { cancelled = true; };
    window.addEventListener('blur', blur);
    // Only an explicit + click asks the native panel to accept keyboard input.
    void windowAction('focusPanel', { reason: 'input' }).then(() => {
      const field = input.current;
      if (!cancelled && field?.getClientRects().length && (document.activeElement === previous || document.activeElement === document.body || document.activeElement === field)) {
        field.focus(); field.scrollIntoView({ block: 'nearest' });
      }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : '无法输入，请再次点击＋重试'); });
    return () => { cancelled = true; window.removeEventListener('blur', blur); };
  }, [open, focusRequest]);

  function discard() {
    setTitle(''); setError(''); setAdded(false); setConfirmClose(false);
    composing.current = false;
  }
  async function save(): Promise<boolean> {
    if (inFlight.current || busy || composing.current) return false;
    if (!title.trim()) { setError('请输入任务名称'); input.current?.focus(); return false; }
    if ([...title.trim()].length > 240) { setError('任务名称不能超过 240 个字'); input.current?.focus(); return false; }
    inFlight.current = true; setSaving(true); setError(''); clearError();
    try {
      await mutate({ type: 'createTask', date: localDate(), task: {
        title: title.trim(), notes: '', priority: 'normal', dueDate: null,
        dueTime: null, dueTimezone: null, addToToday: true,
      } });
      setTitle(''); setAdded(true); setConfirmClose(false);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未能添加，内容已保留，请重试');
      return false;
    } finally {
      returnToInput.current = true;
      inFlight.current = false; setSaving(false);
    }
  }
  useDraft('panel-quick-add', { dirty: title.length > 0, save, discard });

  function leave(action: () => void) {
    if (inFlight.current || busy) return;
    if (title.length) {
      pendingLeave.current = action; setConfirmClose(true);
      input.current?.scrollIntoView({ block: 'nearest' });
    } else { onClose(); action(); }
  }
  useImperativeHandle(ref, () => ({ leave }));
  function finishLeave() {
    const action = pendingLeave.current;
    pendingLeave.current = null; setConfirmClose(false); onClose(); action?.();
  }
  if (!open) return null;
  return <form id="quick-today-add" className="edge-quick-add" aria-label="快速添加今日任务" onSubmit={event => {
    event.preventDefault(); if (!composing.current && !confirmClose) void save();
  }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (inFlight.current || locked) return;
      if (confirmClose) { returnToInput.current = true; setConfirmClose(false); pendingLeave.current = null; }
      else leave(() => {});
    }
  }}>
    <div className="edge-quick-add-fields">
      <input ref={input} aria-label="今日任务名称" aria-invalid={Boolean(error)} aria-describedby={error ? 'quick-today-error' : 'quick-today-hint'} placeholder="今天想做什么？" value={title} disabled={locked || confirmClose} autoComplete="off"
        onClick={() => { void windowAction('focusPanel', { reason: 'input' }).catch(reason => setError(reason instanceof Error ? reason.message : '无法输入，请再次点击输入框重试')); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onChange={event => { setTitle(event.target.value); setError(''); setAdded(false); }}/>
      <button type="submit" className="edge-quick-add-submit" aria-label="添加到今日" disabled={locked || confirmClose}>{saving ? <LoaderCircle className="spin" size={13}/> : '添加'}</button>
    </div>
    {error && <p className="edge-quick-add-error" id="quick-today-error" role="alert">{error}</p>}
    {confirmClose ? <div className="edge-quick-add-confirm" role="group" aria-label="处理今日任务草稿">
      <p>这项任务还没添加。</p><div>
        <button type="button" disabled={locked} onClick={() => { void save().then(saved => { if (saved) finishLeave(); }); }}>保存并收起</button>
        <button type="button" disabled={locked} onClick={() => { discard(); finishLeave(); }}>放弃草稿</button>
        <button ref={continueButton} type="button" disabled={locked} onClick={() => { returnToInput.current = true; setConfirmClose(false); pendingLeave.current = null; }}>继续编辑</button>
      </div>
    </div> : <div className="edge-quick-add-foot"><span id="quick-today-hint" role="status">{added ? <><Check size={12}/>已加入今日，继续添加</> : '回车添加到今日'}</span><button type="button" className="icon-button" aria-label="收起添加任务" title="收起添加任务" disabled={locked} onClick={() => leave(() => {})}><X size={13}/></button></div>}
  </form>;
}
