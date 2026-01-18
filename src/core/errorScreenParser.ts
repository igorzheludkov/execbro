/**
 * Error Screen Parser
 *
 * Parses React Native error screens from OCR text to extract structured error information.
 * Used as fallback when CDP connection cannot be established due to bundle errors.
 */

import { BundleError } from "./bundle.js";

/**
 * Result of parsing an error screen
 */
export interface ParsedErrorScreen {
    found: boolean;
    error?: BundleError;
    rawText?: string;
}

/**
 * Parse OCR text from a React Native error screen (red screen of death)
 *
 * Common error formats:
 * - "Unable to resolve \"@/module\" from \"path/to/file.ts\""
 * - "SyntaxError: ..."
 * - "TransformError: ..."
 * - "Error: ..."
 */
export function parseErrorScreenText(ocrText: string): ParsedErrorScreen {
    if (!ocrText || ocrText.trim().length === 0) {
        return { found: false };
    }

    const normalizedText = normalizeOcrText(ocrText);

    // Check if this looks like an error screen
    if (!looksLikeErrorScreen(normalizedText)) {
        return { found: false, rawText: ocrText };
    }

    const error: BundleError = {
        timestamp: new Date(),
        type: "other",
        message: ""
    };

    // Try to parse different error types

    // 1. Module resolution errors: "Unable to resolve \"module\" from \"file\""
    const resolutionMatch = normalizedText.match(
        /unable\s+to\s+resolve\s+["']([^"']+)["']\s+from\s+["']([^"']+)["']/i
    );
    if (resolutionMatch) {
        error.type = "resolution";
        error.message = `Unable to resolve "${resolutionMatch[1]}"`;
        error.file = resolutionMatch[2];

        // Try to extract import stack
        error.importStack = extractImportStack(normalizedText);

        return { found: true, error, rawText: ocrText };
    }

    // 2. Syntax errors
    const syntaxMatch = normalizedText.match(/syntax\s*error[:\s]+(.+?)(?:\n|$)/i);
    if (syntaxMatch) {
        error.type = "syntax";
        error.message = `SyntaxError: ${syntaxMatch[1].trim()}`;

        // Try to extract file location
        const locationInfo = extractFileLocation(normalizedText);
        if (locationInfo) {
            error.file = locationInfo.file;
            error.line = locationInfo.line;
            error.column = locationInfo.column;
        }

        return { found: true, error, rawText: ocrText };
    }

    // 3. Transform errors (Babel/Metro transforms)
    const transformMatch = normalizedText.match(/transform\s*error[:\s]+(.+?)(?:\n|$)/i);
    if (transformMatch) {
        error.type = "transform";
        error.message = `TransformError: ${transformMatch[1].trim()}`;

        const locationInfo = extractFileLocation(normalizedText);
        if (locationInfo) {
            error.file = locationInfo.file;
            error.line = locationInfo.line;
            error.column = locationInfo.column;
        }

        return { found: true, error, rawText: ocrText };
    }

    // 4. Generic error pattern: "Error: message"
    const errorMatch = normalizedText.match(/error[:\s]+(.+?)(?:\n|$)/i);
    if (errorMatch) {
        error.message = errorMatch[1].trim();

        const locationInfo = extractFileLocation(normalizedText);
        if (locationInfo) {
            error.file = locationInfo.file;
            error.line = locationInfo.line;
            error.column = locationInfo.column;
        }

        return { found: true, error, rawText: ocrText };
    }

    // 5. Fallback: use the entire text as the error message
    // Truncate if too long
    const maxLength = 500;
    error.message = normalizedText.length > maxLength
        ? normalizedText.substring(0, maxLength) + "..."
        : normalizedText;

    return { found: true, error, rawText: ocrText };
}

/**
 * Normalize OCR text by fixing common OCR errors and standardizing whitespace
 */
function normalizeOcrText(text: string): string {
    return text
        // Replace multiple whitespace with single space
        .replace(/\s+/g, " ")
        // Fix common OCR misreadings
        .replace(/[|l]mport/gi, "import")
        .replace(/reso[|l]ve/gi, "resolve")
        .replace(/unab[|l]e/gi, "unable")
        .replace(/modu[|l]e/gi, "module")
        // Normalize quotes
        .replace(/[""'']/g, '"')
        .trim();
}

/**
 * Check if OCR text looks like a React Native error screen
 */
function looksLikeErrorScreen(text: string): boolean {
    const lowerText = text.toLowerCase();

    const errorIndicators = [
        "error",
        "unable to resolve",
        "syntax error",
        "transform error",
        "bundling failed",
        "metro has encountered an error",
        "failed to construct",
        "unexpected token",
        "module not found",
        "cannot find module",
        "import stack",
        ".tsx",
        ".ts",
        ".js",
        ".jsx"
    ];

    return errorIndicators.some(indicator => lowerText.includes(indicator));
}

/**
 * Extract file location (file:line:column) from text
 */
function extractFileLocation(text: string): { file: string; line?: number; column?: number } | null {
    // Pattern: /path/to/file.tsx:123:45 or /path/to/file.tsx:123
    const locationMatch = text.match(
        /([a-zA-Z0-9_\-./\\@]+\.(tsx?|jsx?|mjs|cjs)):(\d+)(?::(\d+))?/i
    );

    if (locationMatch) {
        return {
            file: locationMatch[1],
            line: parseInt(locationMatch[3], 10),
            column: locationMatch[4] ? parseInt(locationMatch[4], 10) : undefined
        };
    }

    // Try to find just a file path
    const fileMatch = text.match(/([a-zA-Z0-9_\-./\\@]+\.(tsx?|jsx?|mjs|cjs))/i);
    if (fileMatch) {
        return { file: fileMatch[1] };
    }

    return null;
}

/**
 * Extract import stack from error text
 */
function extractImportStack(text: string): string[] | undefined {
    const stack: string[] = [];

    // Look for patterns like:
    // - "import from file.tsx"
    // - "app/hooks/useAuth.ts"
    // - file references in the text

    const filePattern = /([a-zA-Z0-9_\-./\\@]+\.(tsx?|jsx?|mjs|cjs))/gi;
    let match;

    while ((match = filePattern.exec(text)) !== null) {
        const file = match[1];
        // Avoid duplicates
        if (!stack.includes(file)) {
            stack.push(file);
        }
    }

    return stack.length > 0 ? stack : undefined;
}

/**
 * Format parsed error for display
 */
export function formatParsedError(parsed: ParsedErrorScreen): string {
    if (!parsed.found || !parsed.error) {
        return "No error detected in screenshot.";
    }

    const { error } = parsed;
    const lines: string[] = [];

    lines.push(`[Screenshot OCR] ${error.type.toUpperCase()} ERROR`);
    lines.push(`Message: ${error.message}`);

    if (error.file) {
        let location = `File: ${error.file}`;
        if (error.line) {
            location += `:${error.line}`;
            if (error.column) {
                location += `:${error.column}`;
            }
        }
        lines.push(location);
    }

    if (error.importStack && error.importStack.length > 0) {
        lines.push("\nImport Stack:");
        error.importStack.forEach(imp => {
            lines.push(`  - ${imp}`);
        });
    }

    lines.push("\n(Captured via screenshot OCR fallback)");

    return lines.join("\n");
}
