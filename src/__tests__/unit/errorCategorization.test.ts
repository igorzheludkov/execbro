import { describe, it, expect } from "@jest/globals";
import { categorizeError } from "../../core/telemetry.js";

/**
 * Cases are the real top failure shapes from the 30d telemetry window ending
 * 2026-08-01 (docs/telemetry/error-tracking-value-analysis.md). Counts in the
 * comments are that window's event volume, so a regression here has a known
 * production cost.
 *
 * The window exposed an inverted categorizer: `execution` held exactly 203
 * events (121+62+20) and every one was a Hermes eval *guard*, while the only
 * genuine runtime fault in the top 25 ("TypeError: undefined is not a
 * function") fell through to `unknown`. `unknown` was 2,313 events — 37% of all
 * failures and the single largest category, which made the category dimension
 * unreadable.
 */
describe("categorizeError", () => {
    describe("Hermes eval guards are validation, not execution", () => {
        // These are documented product limitations the tool description already
        // warns about. They mean the agent wrote an unsupported expression, not
        // that anything faulted at runtime.
        it.each([
            ["Error: Multi-statement expressions are not supported by Hermes Runtime.evaluate", 121],
            ["Error: require() is not available in Hermes Runtime.evaluate", 62],
            ["Error: top-level await is not supported in Hermes Runtime.evaluate", 20],
        ])("%s", (message) => {
            expect(categorizeError(message)).toBe("validation");
        });
    });

    /**
     * input_text's targeting guards. The tool refused before writing because
     * the request did not name a reachable field, and it returned the list of
     * fields that ARE there — a two-step protocol, not a fault. Only "no
     * focused TextInput" was listed, so on 2.6.1 (3d window ending 2026-08-05)
     * 29 of 35 input_text failures landed in `unknown`, burying the 2 real
     * devtools-hook faults.
     */
    describe("input targeting guards are validation", () => {
        it.each([
            "Error: no TextInput matched that target (4 input(s) mounted)",
            "Error: 2 inputs match this target — pass index to choose one, or target more precisely",
            "Error: index 1 is out of range — 1 input(s) matched",
            "Error: no TextInput found on screen",
            "Error: no focused TextInput. Pass testID (or component) so this tool can focus a field itself",
        ])("%s", (message) => {
            expect(categorizeError(message)).toBe("validation");
        });

        // The guards must not swallow a genuinely broken app state.
        it("leaves a missing devtools hook as a connection problem", () => {
            expect(categorizeError("Error: no devtools hook")).toBe("connection");
        });
    });

    describe("genuine JS runtime faults are execution", () => {
        it.each([
            "Error: TypeError: undefined is not a function",
            "TypeError: Cannot read property 'map' of undefined",
            "ReferenceError: foo is not defined",
            "RangeError: Maximum call stack size exceeded",
            "null is not an object (evaluating 'a.b')",
        ])("%s", (message) => {
            expect(categorizeError(message)).toBe("execution");
        });

        it("beats the broad 'fetch' network match when a real fault mentions fetch", () => {
            expect(categorizeError("TypeError: fetch is not a function")).toBe("execution");
        });
    });

    describe("native command failures are execution", () => {
        it.each([
            "Error: Failed to launch app: Command failed: xcrun simctl launch UDID com.example.dev",
            "Error: Failed to capture screenshot: Command failed: adb -s SERIAL shell screencap",
        ])("%s", (message) => {
            expect(categorizeError(message)).toBe("execution");
        });

        it("still prefers driver_missing when the driver is absent entirely", () => {
            expect(categorizeError("adb is not installed or not in PATH")).toBe("driver_missing");
        });
    });

    describe("agent-input and UI-state guards are validation", () => {
        it.each([
            ["Error: no focused TextInput. Tap an input first", 243],
            ["Must provide at least one of: text, testID, component, or x/y coordinates", 15],
            ["Element matches the query but is not visible on screen", 31],
            ["Inspect at (100,200): No component found at this point", 18],
            ["Error: No <Provider store> with a redux-shaped store found in the fiber tree.", 14],
        ])("%s", (message) => {
            expect(categorizeError(message)).toBe("validation");
        });
    });

    describe("device-name mismatch splits on whether anything is connected", () => {
        it("is validation when devices exist but the name does not match", () => {
            expect(
                categorizeError('No connected device matches "iPhone". Connected devices: Pixel_7'),
            ).toBe("validation");
        });

        it("is connection when nothing is connected at all", () => {
            // Message continues into the scan_metro hint, which is a genuine
            // connection problem rather than a bad argument.
            expect(
                categorizeError(
                    'No connected device matches "iPhone". No devices are currently connected — run scan_metro to discover and connect to Metro servers.',
                ),
            ).toBe("connection");
        });
    });

    describe("app-state and environment problems are connection", () => {
        it.each([
            ["Error: React DevTools hook not found.", 23],
            ["Error: React DevTools hook not registered (likely a production / non-__DEV__ build)", 14],
            ["Error: No Android device connected. Connect a device or start an emulator.", 27],
            ["Connection succeeded but app is not available", 38],
        ])("%s", (message) => {
            expect(categorizeError(message)).toBe("connection");
        });
    });

    describe("pre-existing behaviour is preserved", () => {
        it.each([
            ["iOS UI driver (idb) is not installed", "driver_missing"],
            ["WebSocket connection ECONNREFUSED", "network"],
            ["Request timed out after 5000ms", "timeout"],
            ["No apps connected — run scan_metro", "connection"],
            ["Compiling JS failed: SyntaxError", "validation"],
            ["No element found matching the query", "validation"],
        ])("%s -> %s", (message, expected) => {
            expect(categorizeError(message)).toBe(expected);
        });

        it("still falls through to unknown for genuinely unrecognised text", () => {
            expect(categorizeError("something nobody has seen before")).toBe("unknown");
        });
    });

    describe("driver_missing still wins via errorContext", () => {
        it("uses the strategy chain when the primary message is generic", () => {
            expect(categorizeError("No element found", "fiber:skipped|idb is not installed")).toBe(
                "driver_missing",
            );
        });
    });
});
