import { connectedApps } from "./state.js";
import { inferIOSDevicePixelRatio } from "./ocr.js";
import { executeInApp } from "./executor.js";
import { pressElement } from "./executor.js";
import { iosTap, iosFindElement, iosScreenshot } from "./ios.js";
import { androidTap, androidFindElement } from "./android.js";

// --- Types ---

export type TapStrategy = "auto" | "fiber" | "accessibility" | "ocr" | "coordinate";

export interface TapQuery {
    text?: string;
    testID?: string;
    component?: string;
    x?: number;
    y?: number;
}

export interface TapOptions {
    text?: string;
    testID?: string;
    component?: string;
    index?: number;
    x?: number;
    y?: number;
    strategy?: TapStrategy;
}

export interface TapAttempt {
    strategy: string;
    reason: string;
}

export interface TapResult {
    success: boolean;
    method?: string;
    query: TapQuery;
    pressed?: string;
    text?: string;
    screen?: string | null;
    path?: string | null;
    component?: string | null;
    tappedAt?: { x: number; y: number };
    convertedTo?: { x: number; y: number; unit: string };
    platform?: string;
    error?: string;
    attempted?: TapAttempt[];
    matches?: Array<{ index: number; component: string; text: string }>;
    suggestion?: string;
}

// --- Helpers ---

export function buildQuery(options: TapOptions): TapQuery {
    const query: TapQuery = {};
    if (options.text !== undefined) query.text = options.text;
    if (options.testID !== undefined) query.testID = options.testID;
    if (options.component !== undefined) query.component = options.component;
    if (options.x !== undefined) query.x = options.x;
    if (options.y !== undefined) query.y = options.y;
    return query;
}

export function isNonAscii(text: string): boolean {
    return /[^\x00-\x7F]/.test(text);
}

export function getAvailableStrategies(
    query: TapQuery,
    strategy: TapStrategy
): string[] {
    if (query.x !== undefined && query.y !== undefined) {
        return ["coordinate"];
    }
    if (strategy !== "auto") {
        return [strategy];
    }
    if (query.component && !query.text && !query.testID) {
        return ["fiber"];
    }
    if (query.testID && !query.text) {
        return ["fiber", "accessibility"];
    }
    if (query.text) {
        const strategies: string[] = [];
        if (!isNonAscii(query.text)) {
            strategies.push("fiber");
        }
        strategies.push("accessibility", "ocr");
        return strategies;
    }
    return ["fiber", "accessibility", "ocr"];
}

export function convertPixelsToPoints(
    pixelX: number,
    pixelY: number,
    platform: "ios" | "android",
    devicePixelRatio: number,
    scaleFactor: number = 1
): { x: number; y: number } {
    const originalX = pixelX * scaleFactor;
    const originalY = pixelY * scaleFactor;
    if (platform === "android") {
        return { x: Math.round(originalX), y: Math.round(originalY) };
    }
    return {
        x: Math.round(originalX / devicePixelRatio),
        y: Math.round(originalY / devicePixelRatio),
    };
}

export async function getCurrentScreen(): Promise<string | null> {
    // Placeholder — will be implemented via fiber tree traversal in Task 7
    return null;
}

export function formatTapSuccess(data: {
    method: string;
    query: TapQuery;
    pressed?: string;
    text?: string;
    screen?: string | null;
    path?: string | null;
    component?: string | null;
    tappedAt?: { x: number; y: number };
    convertedTo?: { x: number; y: number; unit: string };
    platform?: string;
}): TapResult {
    return {
        success: true,
        ...data,
    };
}

export function formatTapFailure(data: {
    query: TapQuery;
    screen?: string | null;
    error?: string;
    attempted: TapAttempt[];
    suggestion: string;
    matches?: Array<{ index: number; component: string; text: string }>;
}): TapResult {
    const errorMsg = data.error || buildErrorMessage(data.query);
    return {
        success: false,
        query: data.query,
        screen: data.screen,
        error: errorMsg,
        attempted: data.attempted,
        suggestion: data.suggestion,
        matches: data.matches,
    };
}

function buildErrorMessage(query: TapQuery): string {
    const parts: string[] = [];
    if (query.text) parts.push(`text="${query.text}"`);
    if (query.testID) parts.push(`testID="${query.testID}"`);
    if (query.component) parts.push(`component="${query.component}"`);
    return `No element found matching ${parts.join(", ")}`;
}
