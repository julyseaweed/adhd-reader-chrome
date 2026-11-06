// PDF points are the source of truth; display scales these same measurements.
export const HIGHLIGHT_OPACITY = .35;
export const HIGHLIGHT_COLORS = ['#f6de82', '#a9cee8', '#c4c7cc'];
export function underlineMetrics(height) {
  return {thickness:Math.max(.65,Math.min(1.2,height*.075)),inset:Math.min(1,height*.08)};
}
