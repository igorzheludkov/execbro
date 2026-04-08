import pixelmatch from "pixelmatch";
import sharp from "sharp";

export interface ScreenshotDiffResult {
    changed: boolean;
    changeRate: number;
    changedPixels: number;
    totalPixels: number;
}

const POSSIBLE_CHANGE = 0.001;  // 0.1% — likely real (text updates, counter changes)
const MIN_CHANGED_PIXELS = 500; // Absolute floor: any change above this is meaningful regardless of screen size
const PIXEL_THRESHOLD = 0.1;    // pixelmatch per-pixel color tolerance (0-1)

export async function compareScreenshots(
    before: Buffer,
    after: Buffer,
    options?: { statusBarHeight?: number }
): Promise<ScreenshotDiffResult> {
    const [imgBefore, imgAfter] = await Promise.all([
        sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);

    // If dimensions differ, treat as fully changed (screen transition likely)
    if (imgBefore.info.width !== imgAfter.info.width || imgBefore.info.height !== imgAfter.info.height) {
        return {
            changed: true,
            changeRate: 1,
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

    const changedPixels = pixelmatch(
        beforeData,
        afterData,
        undefined,
        width,
        croppedHeight,
        { threshold: PIXEL_THRESHOLD }
    );

    const changeRate = changedPixels / totalPixels;

    return {
        changed: changeRate >= POSSIBLE_CHANGE || changedPixels >= MIN_CHANGED_PIXELS,
        changeRate,
        changedPixels,
        totalPixels,
    };
}
