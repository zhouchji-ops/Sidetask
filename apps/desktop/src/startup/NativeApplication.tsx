import { useEffect, type ReactNode } from 'react';
import { attachNativeNavigation } from '../lib/native';
import { AppStoreProvider } from '../lib/store';

function NativeNavigation({ children }: { children: ReactNode }) {
  useEffect(() => {
    let done = false;
    let cleanup: (() => void) | undefined;
    void attachNativeNavigation().then(stop => { if (done) stop(); else cleanup = stop; });
    return () => { done = true; cleanup?.(); };
  }, []);
  return children;
}

// Mount the complete surface before connecting its native navigation bridge.
// Child event handlers and the store keep their existing effect order.
export default function NativeApplication({ children }: { children: ReactNode }) {
  return <AppStoreProvider><NativeNavigation>{children}</NativeNavigation></AppStoreProvider>;
}
