import { useCallback, useState } from 'react';

/** The desktop menu column's collapsed choice, remembered on this device (shell polish 2026-10-18, section 4). */
export const MENU_COLLAPSED_KEY = 'k42.menuCollapsed';

export function readMenuCollapsed(storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return storage?.getItem(MENU_COLLAPSED_KEY) === '1'; } catch { return false; }
}

export function writeMenuCollapsed(storage: Pick<Storage, 'setItem'> | null, value: boolean): void {
  try { storage?.setItem(MENU_COLLAPSED_KEY, value ? '1' : '0'); } catch { /* Blocked storage keeps the choice for this visit only. */ }
}

const safeLocalStorage = (): Storage | null => { try { return window.localStorage; } catch { return null; } };

export function useMenuCollapsed(): [collapsed: boolean, setCollapsed: (value: boolean) => void] {
  const [collapsed, set] = useState(() => readMenuCollapsed(safeLocalStorage()));
  const setCollapsed = useCallback((value: boolean) => { set(value); writeMenuCollapsed(safeLocalStorage(), value); }, []);
  return [collapsed, setCollapsed];
}
