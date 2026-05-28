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
}

export type LabelMap = Record<number, BBox>;
