/**
 * Color coding for the three anatomical planes.
 * Each panel's crosshair lines are colored to indicate which OTHER plane they represent.
 *
 *   Axial   (Z fixed):  shows Y = coronal(green)  and X = sagittal(yellow)
 *   Coronal (Y fixed):  shows Z = axial(red)       and X = sagittal(yellow)
 *   Sagittal(X fixed):  shows Z = axial(red)       and Y = coronal(green)
 */

export const PLANE_COLOR = {
  axial:    '#F34A33',  // red
  coronal:  '#6EB04B',  // green
  sagittal: '#EDD54C',  // yellow
} as const;

export const CROSSHAIR_COLORS = {
  axial:    { h: PLANE_COLOR.coronal,  v: PLANE_COLOR.sagittal },
  coronal:  { h: PLANE_COLOR.axial,    v: PLANE_COLOR.sagittal },
  sagittal: { h: PLANE_COLOR.axial,    v: PLANE_COLOR.coronal  },
} as const;

export type CrosshairAxis = keyof typeof CROSSHAIR_COLORS;

/** Gap (px) left clear around the crosshair center. */
export const CROSSHAIR_GAP = 14;

/** Length (px) of each crosshair arm from the gap outward. */
export const CROSSHAIR_ARM = 48;

/** Broadcast channel name for crosshair hover position. */
export const CROSSHAIR_HOVER_EVENT  = 'accta:crosshair-hover';
export const CROSSHAIR_LEAVE_EVENT  = 'accta:crosshair-leave';
