import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface Draft { dirty: boolean; save: () => Promise<boolean>; discard: () => void }
interface Drafts {
  dirty: boolean;
  put: (id: string, draft: Draft | null) => void;
  saveAll: () => Promise<boolean>;
  discardAll: () => void;
}
const Context = createContext<Drafts | null>(null);
export function DraftProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Draft>());
  const [dirty, setDirty] = useState(false);
  const put = useCallback((id: string, draft: Draft | null) => {
    if (draft) entries.current.set(id, draft); else entries.current.delete(id);
    setDirty([...entries.current.values()].some(value => value.dirty));
  }, []);
  const saveAll = useCallback(async () => {
    // Each editor validates its own form and retains its draft on failure.
    for (const draft of [...entries.current.values()]) {
      if (draft.dirty && !await draft.save()) return false;
    }
    return true;
  }, []);
  const discardAll = useCallback(() => {
    for (const draft of [...entries.current.values()]) if (draft.dirty) draft.discard();
  }, []);
  const value = useMemo(() => ({ dirty, put, saveAll, discardAll }), [dirty, put, saveAll, discardAll]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useDrafts() {
  const value = useContext(Context);
  if (!value) throw new Error('DraftProvider is missing');
  return value;
}
export function useDraft(id: string, draft: Draft) {
  const { put } = useDrafts();
  useLayoutEffect(() => { put(id, draft); });
  useEffect(() => () => put(id, null), [id, put]);
}
