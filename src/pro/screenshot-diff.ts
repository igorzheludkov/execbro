import pixelmatch from "pixelmatch";
import sharp from "sharp";

export interface ScreenshotDiffResult {
    changed: boolean;
    changeRate: number;
    changedPixels: number;
    totalPixels: number;
}

const CHANGE_THRESHOLD = 0.005; // 0.5% of pixels must change to be "meaningful"
const PIXEL_THRESHOLD = 0.1; // pixelmatch per-pixel color tolerance (0-1)

export async function compareScreenshots(
    before: Buffer,
    after: Buffer
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
    const totalPixels = width * height;

    const changedPixels = pixelmatch(
        new Uint8Array(imgBefore.data.buffer, imgBefore.data.byteOffset, imgBefore.data.byteLength),
        new Uint8Array(imgAfter.data.buffer, imgAfter.data.byteOffset, imgAfter.data.byteLength),
        undefined,
        width,
        height,
        { threshold: PIXEL_THRESHOLD }
    );

    const changeRate = changedPixels / totalPixels;

    return {
        changed: changeRate > CHANGE_THRESHOLD,
        changeRate,
        changedPixels,
        totalPixels,
    };
}
