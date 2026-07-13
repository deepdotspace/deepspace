'use client';

import React, { useEffect, type ReactNode } from 'react';
import type { DeepSpaceThemeConfig } from './types';
import { applyDeepSpaceTheme, readThemeFromDOM } from './applyTheme';

export interface DeepSpaceThemeProviderProps {
  children: ReactNode;
  /**
   * Explicit theme config. If omitted, auto-detects from the widget's
   * --color-* CSS custom properties (defined in the @theme block of styles.css).
   */
  theme?: DeepSpaceThemeConfig;
}

/**
 * DeepSpaceThemeProvider — sets --theme-* CSS variables for pill,
 * and other DeepSpace UI components on deployed sites and mini-apps.
 *
 * **Zero-config**: reads colors from the widget's @theme CSS block.
 * **Explicit**: pass a `theme` prop to override.
 *
 * @example
 * ```tsx
 * // Zero-config — reads from styles.css @theme block
 * <DeepSpaceThemeProvider>
 *   <App />
 * </DeepSpaceThemeProvider>
 *
 * // Explicit theme
 * <DeepSpaceThemeProvider theme={{
 *   primaryColor: '#0f172a',
 *   secondaryColor: '#1e293b',
 *   accentColor: '#8b5cf6',
 *   textColor: '#f1f5f9',
 * }}>
 *   <App />
 * </DeepSpaceThemeProvider>
 * ```
 */
export function DeepSpaceThemeProvider({
  children,
  theme,
}: DeepSpaceThemeProviderProps): React.ReactElement {
  useEffect(() => {
    const root = document.documentElement;
    const config = theme ?? readThemeFromDOM(root);
    applyDeepSpaceTheme(config, root);
  }, [theme]);

  return <>{children}</>;
}
