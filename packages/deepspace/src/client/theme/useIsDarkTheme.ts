'use client';

import { useState, useEffect } from 'react';

/**
 * Reads `data-ui-theme` from the root element (set by `applyDeepSpaceTheme`)
 * and re-evaluates when a `canvas-theme-changed` event fires.
 */
export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document === 'undefined' || document.documentElement.dataset.uiTheme !== 'light',
  );

  useEffect(() => {
    const update = (): void => {
      setIsDark(document.documentElement.dataset.uiTheme !== 'light');
    };
    update();
    window.addEventListener('canvas-theme-changed', update);
    return () => window.removeEventListener('canvas-theme-changed', update);
  }, []);

  return isDark;
}
