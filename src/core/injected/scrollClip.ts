/**
 * What part of an element is actually on screen, in window points.
 *
 * Two errors this replaces, both measured on a Pixel 9 emulator:
 *  - The root view measures at y=-54 (the window starts below the status bar), and the
 *    viewport bottom was computed as `height + max(y, 0)`, 54pt too low. A field past the
 *    real bottom edge was listed with a coordinate below the screenshot.
 *  - Nothing clipped by the scroll container. A field scrolled under the bottom tab bar is
 *    inside the window but outside its ScrollView, and was listed as tappable; a chip cut
 *    by a horizontal row got the centre of its full frame, off the right edge.
 * The chromium path already clips by overflow ancestors (visibleRect in chromiumScreen.ts).
 *
 * Self-contained functions on purpose: SCROLL_CLIP_JS injects them with toString().
 */

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Bottom edge of the viewport in window coordinates: the root's own bottom edge. */
export function viewportBottom(root: Rect): number {
    return root.y + root.height;
}

/** The part of `m` inside every measured scroller, or null when nothing of it is visible. */
export function clipToScrollers(m: Rect, clips: Array<Rect | null | undefined>): Rect | null {
    var x1 = m.x, y1 = m.y, x2 = m.x + m.width, y2 = m.y + m.height;
    for (var i = 0; i < clips.length; i++) {
        var c = clips[i];
        if (!c || !(c.width > 0) || !(c.height > 0)) continue;
        if (c.x > x1) x1 = c.x;
        if (c.y > y1) y1 = c.y;
        if (c.x + c.width < x2) x2 = c.x + c.width;
        if (c.y + c.height < y2) y2 = c.y + c.height;
    }
    if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
    if (x1 === m.x && y1 === m.y && x2 === m.x + m.width && y2 === m.y + m.height) return m;
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Host component names of a scroll container on iOS and Android. */
export const SCROLL_HOSTS = ["RCTScrollView", "AndroidHorizontalScrollView"];

export const SCROLL_CLIP_JS = [
    `var clipToScrollers = ${clipToScrollers.toString()};`,
    `var viewportBottom = ${viewportBottom.toString()};`,
    `var SCROLL_HOSTS = ${JSON.stringify(SCROLL_HOSTS)};`,
    // Up to 4 scroll ancestors, nearest first: nested lists clip by every container.
    `function scrollAncestorsOf(fiber) {
        var out = [], cur = fiber ? fiber.return : null, d = 0;
        while (cur && d < 500 && out.length < 4) {
            if (typeof cur.type === 'string' && SCROLL_HOSTS.indexOf(cur.type) !== -1) out.push(cur);
            cur = cur.return;
            d++;
        }
        return out;
    }`,
].join("\n");
