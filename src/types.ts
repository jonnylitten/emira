export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedElement {
  label: number;
  bbox: BBox;
  type: string;
  text: string;
  // OmniParser tags every detection as interactive (icon/button) or not
  // (static text label). The DOM detector only ever finds interactive
  // elements, so it always sets this to true. Used by `interactive_only`
  // filtering on screenshot_mark to drop static-text noise.
  interactive: boolean;
}

export type LabelMap = Record<number, BBox>;
