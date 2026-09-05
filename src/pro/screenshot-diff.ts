import pixelmatch from "pixelmatch";
import sharp from "sharp";

export interface ScreenshotDiffResult {
    changed: boolean;
    changeRate: number;
    changedPixels: number;
    totalPixels: number;
    /**
     * Where the change is, in delivered-screenshot pixels — the same space
     * `tap` and the layout tools read and write (see core/screenSpace.ts), so a
     * box can be handed straight back to another tool. Only present when
     * `regions: true` was requested; computing it costs an extra full-size
     * buffer, which the tap burst loop diffs far too often to pay for.
     *
     * A change rate on its own is not actionable: it says something moved, not
     * what. The whole point of a box is that the agent can crop it, OCR it, or
     * tap it.
     */
    regions?: DiffRegion[];
}

export interface DiffRegion {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Changed pixels inside this box, which is <= width*height. */
    changedPixels: number;
}

const POSSIBLE_CHANGE = 0.0005; // 0.05% — small UI state changes (pill selection, toggle highlight)
const MIN_CHANGED_PIXELS = 200; // Absolute floor: a single character change is ~200-400px at typical resolutions
const PIXEL_THRESHOLD = 0.1;    // pixelmatch per-pixel color tolerance (0-1)

// Region detection works on a coarse grid rather than per-pixel connected
// components: at 16px a full-screen diff is ~11k cells instead of ~3M pixels,
// which keeps the flood fill trivial, and a box finer than 16px is below the
// size of anything an agent can act on anyway.
const REGION_CELL = 16;
// More boxes than this stops being a localisation and starts being a second
// copy of the image. Callers get the largest ones; changedPixels still reports
// the true total, so a truncated list never reads as a smaller change.
const MAX_REGIONS = 5;

/**
 * Bounding boxes of connected changed areas, from a pixelmatch diff mask
 * (`diffMask: true` leaves unchanged pixels fully transparent, so alpha > 0 is
 * exactly "this pixel changed").
 *
 * `yOffset` adds back the status-bar rows cropped before the compare, so boxes
 * come out in full-screenshot coordinates rather than cropped-image ones.
 */
function findRegions(mask: Uint8Array, width: number, height: number, yOffset: number): DiffRegion[] {
    const cols = Math.ceil(width / REGION_CELL);
    const rows = Math.ceil(height / REGION_CELL);
    const cellCounts = new Int32Array(cols * rows);

    for (let y = 0; y < height; y++) {
        const cellRow = (y / REGION_CELL) | 0;
        for (let x = 0; x < width; x++) {
            if (mask[(y * width + x) * 4 + 3] === 0) continue;
            cellCounts[cellRow * cols + ((x / REGION_CELL) | 0)]++;
        }
    }

    const seen = new Uint8Array(cols * rows);
    const regions: DiffRegion[] = [];

    for (let start = 0; start < cellCounts.length; start++) {
        if (seen[start] || cellCounts[start] === 0) continue;
        // Iterative flood fill — a recursive one blows the stack on a
        // full-screen transition, which is the case that matters most.
        const stack = [start];
        seen[start] = 1;
        let minCol = cols, maxCol = -1, minRow = rows, maxRow = -1, changedPixels = 0;

        while (stack.length > 0) {
            const cell = stack.pop() as number;
            const col = cell % cols;
            const row = (cell / cols) | 0;
            changedPixels += cellCounts[cell];
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (row < minRow) minRow = row;
            if (row > maxRow) maxRow = row;

            // 4-connectivity. Diagonal touching usually means two separate
            // widgets that happen to be near each other, and merging those
            // produces a box covering mostly unchanged screen.
            if (col > 0) push(cell - 1);
            if (col < cols - 1) push(cell + 1);
            if (row > 0) push(cell - cols);
            if (row < rows - 1) push(cell + cols);
        }

        function push(next: number): void {
            if (seen[next] || cellCounts[next] === 0) return;
            seen[next] = 1;
            stack.push(next);
        }

        const x = minCol * REGION_CELL;
        const y = minRow * REGION_CELL;
        regions.push({
            x,
            y: y + yOffset,
            // Clamp: the last cell in a row/column is partial whenever the
            // image is not an exact multiple of REGION_CELL.
            width: Math.min((maxCol + 1) * REGION_CELL, width) - x,
            height: Math.min((maxRow + 1) * REGION_CELL, height) - y,
            changedPixels,
        });
    }

    return regions.sort((a, b) => b.changedPixels - a.changedPixels).slice(0, MAX_REGIONS);
}

export async function compareScreenshots(
    before: Buffer,
    after: Buffer,
    options?: { statusBarHeight?: number; regions?: boolean }
): Promise<ScreenshotDiffResult> {
    const [imgBefore, imgAfter] = await Promise.all([
        sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);

    // If dimensions differ, treat as fully changed (screen transition likely)
    if (imgBefore.info.width !== imgAfter.info.width || imgBefore.info.height !== imgAfter.info.height) {
        const w = Math.max(imgBefore.info.width, imgAfter.info.width);
        const h = Math.max(imgBefore.info.height, imgAfter.info.height);
        return {
            changed: true,
            changeRate: 1,
            // Dimensions differing means a screen transition or a rotation.
            // "Everything changed" is the honest box; pretending to localise
            // inside two images of different sizes would be made up.
            ...(options?.regions ? { regions: [{ x: 0, y: 0, width: w, height: h, changedPixels: w * h }] } : {}),
            changedPixels: Math.max(
                imgBefore.info.width * imgBefore.info.height,
                imgAfter.info.width * imgAfter.info.height
            ),
            totalPixels: Math.max(
                imgBefore.info.width * imgBefore.info.height,
                imgAfter.info.width * imgAfter.info.height
            ),
        };
    }

    const { width, height } = imgBefore.info;

    // Crop out status bar: skip the first statusBarPx rows of pixels
    const statusBarPx = options?.statusBarHeight ?? 0;
    const croppedHeight = height - statusBarPx;
    const totalPixels = width * croppedHeight;

    const rowBytes = width * 4; // RGBA
    const skipBytes = statusBarPx * rowBytes;

    const beforeData = new Uint8Array(
        imgBefore.data.buffer, imgBefore.data.byteOffset + skipBytes, croppedHeight * rowBytes
    );
    const afterData = new Uint8Array(
        imgAfter.data.buffer, imgAfter.data.byteOffset + skipBytes, croppedHeight * rowBytes
    );

    // diffMask leaves unchanged pixels transparent instead of faded grey, so
    // region detection can test alpha alone. Only allocated when asked for.
    const mask = options?.regions ? new Uint8Array(width * croppedHeight * 4) : undefined;

    const changedPixels = pixelmatch(
        beforeData,
        afterData,
        mask,
        width,
        croppedHeight,
        { threshold: PIXEL_THRESHOLD, diffMask: true }
    );

    const changeRate = changedPixels / totalPixels;
    const changed = changeRate >= POSSIBLE_CHANGE || changedPixels >= MIN_CHANGED_PIXELS;

    return {
        changed,
        changeRate,
        changedPixels,
        totalPixels,
        // Skip the scan when nothing changed: findRegions would return [] anyway
        // and a full-screen mask walk is the most expensive part of this path.
        ...(mask && changed ? { regions: findRegions(mask, width, croppedHeight, statusBarPx) } : {}),
    };
}
