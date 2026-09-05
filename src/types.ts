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
  // Identity handle for the DOM detector: the value of the `data-emira-ref`
  // attribute stamped on the live node at detection time. Actions resolve the
  // element by this attribute and act on the node, so a scroll between capture
  // and action cannot drift the click onto a different element. Undefined for
  // the OmniParser detector, whose labels are pixel regions with no DOM node;
  // those fall back to coordinate clicks.
  ref?: number;
  // OmniParser tags every detection as interactive (icon/button) or not
  // (static text label). The DOM detector only ever finds interactive
  // elements, so it always sets this to true. Used by `interactive_only`
  // filtering on screenshot_mark to drop static-text noise.
  interactive: boolean;
}

export type LabelMap = Record<number, BBox>;
