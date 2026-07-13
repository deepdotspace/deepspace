/**
 * DeepSpace Theme Configuration
 *
 * Defines the color scheme for DeepSpace UI components (pills, panels, etc.)
 * on deployed sites and mini-apps.
 *
 * Pass to <DeepSpaceThemeProvider theme={config}> or leave undefined
 * for automatic detection from the widget's --color-* CSS variables.
 */
export interface DeepSpaceThemeConfig {
  /** Panel/toolbar background color (e.g., '#0f172a' for dark themes) */
  primaryColor: string;
  /** Optional override for panel-specific backgrounds (defaults to primaryColor) */
  panelColor?: string;
  /** Secondary/button background color (e.g., '#1e293b') */
  secondaryColor: string;
  /** Accent color for interactive elements and highlights (e.g., '#8b5cf6') */
  accentColor: string;
  /** Text color on accent backgrounds (default: '#ffffff') */
  accentContrastColor?: string;
  /** Primary text color (e.g., '#f1f5f9') */
  textColor: string;
  /** Shadow color (default: '#000000') */
  shadowColor?: string;
  /** Border color — defaults to secondaryColor if omitted */
  borderColor?: string;
  /** Page background color — used for dark/light mode detection (e.g., '#0a0f1a') */
  backgroundColor?: string;
  /** Highlight color for glass effects (default: '#ffffff') */
  highlightColor?: string;
  /** Enable glassmorphism blur effects (default: true) */
  glassmorphism?: boolean;
}
