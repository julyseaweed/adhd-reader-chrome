// PDF points are the source of truth; display scales these same measurements.
export const HIGHLIGHT_OPACITY = .35;
export const HIGHLIGHT_COLORS = ['#f6de82', '#a9cee8', '#c4c7cc'];
export function underlineMetrics(height) {
  const thickness=Math.max(.3,Math.min(.6,height*.035));
  return {thickness,inset:Math.max(height*.04,thickness/2)};
}

/** Stroke coordinates are shared by the live overlay and the PDF appearance. */
export function underlineStroke(rect, rotation = 0) {
  const [x1,y1,x2,y2]=rect,angle=((rotation%360)+360)%360;
  const height=angle===90||angle===270?x2-x1:y2-y1;
  const {thickness,inset}=underlineMetrics(height);
  if(angle===90)return {start:[x2-inset,y1],end:[x2-inset,y2],thickness};
  if(angle===180)return {start:[x2,y2-inset],end:[x1,y2-inset],thickness};
  if(angle===270)return {start:[x1+inset,y2],end:[x1+inset,y1],thickness};
  return {start:[x1,y1+inset],end:[x2,y1+inset],thickness};
}
