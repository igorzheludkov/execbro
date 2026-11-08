import sharp from "sharp";

/** How long to wait before the one retry of a blank capture. */
export const BLANK_RETRY_MS = 500;

/** Share of the height skipped at each edge: covers status bar (~7%) and nav bar (~5%) on a Pixel 9. */
const BAR_MARGIN = 0.1;

/**
 * True when the frame carries no picture at all: every channel's standard
 * deviation under 2. A capture taken before the app's first paint looks like
 * this, and showing it beside an element list read from the React tree makes
 * the two disagree.
 */
export async function isNearUniform(image: Buffer): Promise<boolean> {
    try {
        // Only the app's band: the OS paints the status and navigation bars before
        // the app's first frame, so a whole-frame check never reads as blank.
        const { width = 0, height = 0 } = await sharp(image).metadata();
        const margin = Math.floor(height * BAR_MARGIN);
        if (width === 0 || height - 2 * margin <= 0) return false;
        // stats() reads the pipeline's INPUT, not its output, so the crop has to be
        // materialized first or the bars are counted anyway.
        const band = await sharp(image).extract({ left: 0, top: margin, width, height: height - 2 * margin }).png().toBuffer();
        const { channels } = await sharp(band).stats();
        return channels.every((c) => c.stdev < 2);
    } catch {
        return false;
    }
}
