import {
    logBuffers,
    networkBuffers,
    getLogBuffer,
    getNetworkBuffer,
    getConnectedAppByDevice,
    LogBuffer,
    NetworkBuffer,
} from "./index.js";
import { UserInputError } from "./errors.js";

// Helper: resolve log buffer for a device (or create a merged buffer from all devices)
export function resolveLogBuffer(device?: string): LogBuffer {
    if (device) {
        const app = getConnectedAppByDevice(device);
        if (!app) throw new UserInputError(`No connected device matches "${device}"`);
        const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
        return getLogBuffer(deviceName);
    }
    // Merge all logs into a temporary buffer for read operations
    const merged = new LogBuffer(5000);
    for (const buffer of logBuffers.values()) {
        for (const entry of buffer.getAll()) {
            merged.add(entry);
        }
    }
    return merged;
}

// Helper: resolve network buffer for a device (or create a merged buffer from all devices)
export function resolveNetworkBuffer(device?: string): NetworkBuffer {
    if (device) {
        const app = getConnectedAppByDevice(device);
        if (!app) throw new UserInputError(`No connected device matches "${device}"`);
        const deviceName = app.deviceInfo.deviceName || app.deviceInfo.title || "unknown";
        return getNetworkBuffer(deviceName);
    }
    // Merge all network requests into a temporary buffer for read operations.
    // Key by the request's own id so get(requestId) works — earlier this used
    // Math.random() which made every direct lookup miss while listings still
    // appeared correct (listings render req.requestId from the value).
    // Multiple devices can share a request id; suffix with deviceName for
    // collisions so we don't lose entries.
    const merged = new NetworkBuffer(5000);
    const seen = new Set<string>();
    for (const [deviceName, buffer] of networkBuffers.entries()) {
        for (const req of buffer.getAll({})) {
            let key = req.requestId;
            if (seen.has(key)) key = `${req.requestId}@${deviceName}`;
            seen.add(key);
            merged.set(key, req);
        }
    }
    return merged;
}

/**
 * Parse JPEG dimensions from a raw buffer by scanning for the SOF marker.
 * Only needs the first ~2KB of the image to find dimensions.
 */
export function getJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    let offset = 2;
    while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];

        // SOF markers: C0-CF except C4 (DHT) and CC (DAC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
        }

        // Skip segment (read its length)
        const segLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segLength;
    }
    return null;
}

// Banner helpers for platform-specific tool descriptions. Appended after the
// verbatim first sentence of every ios_*/android_* tool to steer agents toward
// cross-platform primaries (tap, get_screen_layout, etc) unless native-only
// behavior is required. See src/core/nativeOnlyHints.ts for the complementary
// runtime hint shown when Metro is absent.
export const platformFallbackBanner = (prefer: string): string =>
    `\n[PLATFORM FALLBACK — prefer ${prefer} unless you specifically need native-only behavior]`;

export const platformUniqueBanner = (useCase: string): string =>
    `\n[PLATFORM-SPECIFIC — no cross-platform equivalent; use when ${useCase}]`;

export const primaryInteractionBanner = (): string =>
    `\n[PRIMARY INTERACTION TOOL — works on iOS and Android; prefer over ios_*/android_* siblings]`;

/**
 * Estimate how many tokens an image will consume in Claude's vision encoder.
 * Per Anthropic docs, Claude auto-resizes images to fit within:
 *   1) 1568px on any side, AND
 *   2) ~1.15 megapixels total (whichever is hit first)
 * Then tokens ≈ (width * height) / 750 (capped at ~1,600 per image).
 * We only decode the first ~2KB of the base64 string to read JPEG dimensions.
 */
export function estimateImageTokens(base64Data: string): number {
    try {
        // Decode only the first ~2KB (2732 base64 chars ≈ 2048 bytes) to find JPEG header
        const headerBase64 = base64Data.slice(0, 2732);
        const buffer = Buffer.from(headerBase64, "base64");
        const dims = getJpegDimensions(buffer);
        if (!dims) return Math.ceil(base64Data.length / 4); // fallback for non-JPEG

        let { width, height } = dims;

        // Step 1: Claude resizes to fit within 1568px on any side
        const MAX_CLAUDE_DIM = 1568;
        if (width > MAX_CLAUDE_DIM || height > MAX_CLAUDE_DIM) {
            const scale = MAX_CLAUDE_DIM / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        // Step 2: Claude further resizes to fit within ~1.15 megapixels
        const MAX_PIXELS = 1_150_000;
        if (width * height > MAX_PIXELS) {
            const scale = Math.sqrt(MAX_PIXELS / (width * height));
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        return Math.ceil((width * height) / 750);
    } catch {
        return Math.ceil(base64Data.length / 4); // fallback
    }
}
