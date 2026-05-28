import sharp from "sharp";
/**
 * Draws red boxes + numbered badges over the screenshot. Uses sharp's SVG
 * composite rather than `canvas` to avoid native build dependencies (cairo,
 * pango).
 */
export async function annotateScreenshot(screenshotBuf, elements) {
    const meta = await sharp(screenshotBuf).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) {
        throw new Error("Could not read screenshot dimensions");
    }
    const overlay = buildSvgOverlay(width, height, elements);
    return sharp(screenshotBuf)
        .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
        .png()
        .toBuffer();
}
function buildSvgOverlay(width, height, elements) {
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    for (const el of elements) {
        const { x, y, w, h } = el.bbox;
        const label = String(el.label);
        // Bounding box
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#FF3B30" stroke-width="2"/>`);
        // Badge sits at the top-left of the box. If the box starts near the top
        // edge, drop the badge inside the box instead of clipping above it.
        const badgeW = label.length * 9 + 8;
        const badgeH = 18;
        const badgeY = y - badgeH < 0 ? y : y - badgeH;
        parts.push(`<rect x="${x}" y="${badgeY}" width="${badgeW}" height="${badgeH}" fill="#FF3B30"/>`);
        parts.push(`<text x="${x + 4}" y="${badgeY + 13}" font-family="monospace" font-size="13" font-weight="bold" fill="#FFFFFF">${escapeXml(label)}</text>`);
    }
    parts.push(`</svg>`);
    return parts.join("");
}
function escapeXml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
//# sourceMappingURL=annotate.js.map