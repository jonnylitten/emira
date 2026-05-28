import { detectInteractiveElements } from "./detect.js";
import { detectViaOmniParser } from "./detectors/omniparser.js";
export function defaultDetector() {
    const env = process.env.MARKSMAN_DETECTOR?.toLowerCase();
    if (env === "omniparser")
        return "omniparser";
    return "dom";
}
export async function detect(name, ctx) {
    switch (name) {
        case "dom":
            return detectInteractiveElements(ctx.page);
        case "omniparser":
            return detectViaOmniParser(ctx.screenshot);
    }
}
//# sourceMappingURL=detector.js.map