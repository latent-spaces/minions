import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
// Track focus before React removes responsive shell controls. A parent effect cleanup
// is too late: child host nodes may already be gone and activeElement may be body.
export function useShellFocus(compact: boolean, content: RefObject<HTMLElement | null>) {
  const focused = useRef<Element | null>(null);
  useEffect(() => {
    const remember = () => { focused.current = document.activeElement; };
    remember();
    document.addEventListener('focusin', remember);
    return () => document.removeEventListener('focusin', remember);
  }, []);
  useLayoutEffect(() => {
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body)
      content.current?.focus({ preventScroll: true });
  }, [compact, content]);
}
