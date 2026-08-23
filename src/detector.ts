import type { Page } from "playwright";
import type { DetectedElement } from "./types.js";
import { detectInteractiveElements } from "./detect.js";
import { detectViaOmniParser } from "./detectors/omniparser.js";

export type DetectorName = "dom" | "omniparser";

export interface DetectContext {
  page: Page;
  screenshot: Buffer;
}

export function defaultDetector(): DetectorName {
  const env = process.env.EMIRA_DETECTOR?.toLowerCase();
  if (env === "omniparser") return "omniparser";
  return "dom";
}

export async function detect(
  name: DetectorName,
  ctx: DetectContext,
): Promise<DetectedElement[]> {
  switch (name) {
    case "dom":
      return detectInteractiveElements(ctx.page);
    case "omniparser":
      return detectViaOmniParser(ctx.screenshot);
  }
}
