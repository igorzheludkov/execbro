import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import {
    androidLongPress,
    androidSwipe,
    androidInputText,
    androidKeyEvent,
    ANDROID_KEY_EVENTS,
    iosButton,
    iosInputText,
    IOS_BUTTON_TYPES,
    getActiveSimulatorUdid,
    getActiveOrBootedSimulatorUdid,
} from "../core/index.js";
import { tap, type TapResult } from "../pro/tap.js";
import { clearFocusedInput, dismissKeyboard, inputTextWithReplace } from "../core/focusedInputTools.js";
import { primaryInteractionBanner, platformFallbackBanner, platformUniqueBanner } from "../core/toolHelpers.js";

export function registerInteractionTools(server: McpServer): void {
    // Tool: Unified tap — tries fiber, accessibility, OCR, coordinate strategies
    registerToolWithTelemetry(
        server,
        "tap",
        {
            description:
                "Tap a UI element. Automatically tries multiple strategies: fiber tree (React), accessibility tree (native), and OCR (visual)." +
                primaryInteractionBanner() + "\n" +
                "PURPOSE: Single unified tap entry point — resolves text/testID/component/coordinates into a real touch event on the correct device.\n" +
                "WHEN TO USE: Any time you need to press a button, focus an input, open a menu, or verify a handler fires. Prefer testID, then text, then component, then (x,y) from a screenshot's pressables list.\n" +
                "WORKFLOW: ios_screenshot or android_screenshot -> tap(testID=\"...\") | tap(text=\"...\") | tap(x, y) -> screenshot again to verify. Use burst=true when meaningful=false but visual feedback looks transient.\n" +
                "LIMITATIONS: iOS needs AXe (brew install cameroncooke/axe/axe) or IDB for accessibility/coordinate taps. Non-ASCII text skips fiber (Hermes); prefer testID. When iOS AND Android are connected, pass platform explicitly.\n" +
                "GOOD: tap({ testID: \"login-btn\" }); tap({ text: \"Submit\" }); tap({ x: 300, y: 600 }); tap({ x: 300, y: 600, native: true, platform: \"android\" })\n" +
                "BAD: tap({ text: \"\" }) or tap({ x: 0, y: 0 }) — missing a target. tap({ text: \"Submit\" }) without first screenshotting an ambiguous screen.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
            inputSchema: {
                text: z
                    .string()
                    .optional()
                    .describe(
                        "Visible text to match (case-insensitive substring). ASCII only for fiber strategy; OCR handles non-ASCII."
                    ),
                testID: z
                    .string()
                    .optional()
                    .describe("Exact match on the element's testID prop."),
                component: z
                    .string()
                    .optional()
                    .describe(
                        "Component name match (case-insensitive substring, e.g. 'Button', 'MenuItem')."
                    ),
                index: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Zero-based index when multiple elements match (default: 0)."
                    ),
                x: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "X coordinate in pixels (from screenshot). Must provide both x and y."
                    ),
                y: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Y coordinate in pixels (from screenshot). Must provide both x and y."
                    ),
                strategy: z
                    .enum(["auto", "fiber", "accessibility", "ocr", "coordinate"])
                    .optional()
                    .default("auto")
                    .describe(
                        '"auto" (default) tries fiber -> accessibility -> OCR. Set explicitly to skip strategies you know will fail.'
                    ),
                maxTraversalDepth: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Max parent levels to traverse when searching by component name (default: 15). " +
                        "Increase if your component is deeply wrapped (e.g. inside multiple HOCs/animation wrappers)."
                    ),
                native: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "When true, tap coordinates directly via ADB/simctl without requiring a React Native connection. " +
                        "Useful for interacting with native UI, system dialogs, or non-RN apps. Requires x/y coordinates."
                    ),
                platform: z
                    .enum(["ios", "android"])
                    .optional()
                    .describe(
                        "Target platform. Required when both iOS and Android devices are connected. Auto-detected if only one platform is available."
                    ),
                device: z
                    .string()
                    .optional()
                    .describe(
                        "Target device name (substring match against the connected RN app's device name). " +
                        "Use to pin the tap to a specific device when multiple are connected (e.g. \"iPhone SE\"). " +
                        "Run get_apps to see connected device names. For iOS, the matched device's simulatorUdid is used to scope the tap."
                    ),
                udid: z
                    .string()
                    .optional()
                    .describe(
                        "iOS simulator UDID (from list_ios_simulators). Takes precedence over device/platform when set. " +
                        "iOS-only — pairing with platform=\"android\" returns an error."
                    ),
                screenshot: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "Return post-tap image bytes in the response. Default true. Set to false to drop the PNG bytes — verification still runs (set verify=false to skip that too). Combine with verify=true to get the meaningful/changeRate signal without paying the ~1MB-per-tap bandwidth cost."
                    ),
                verify: z
                    .boolean()
                    .optional()
                    .describe(
                        "Run before/after screenshot diff to detect if the tap had a meaningful visual effect. " +
                        "Default: true for coordinate/accessibility/ocr strategies, false for fiber. " +
                        "Independent of `screenshot` — verify can run with screenshot=false (the diff is computed internally; image bytes are dropped). " +
                        "When skipped, the response contains `verification: { skipped: true, skippedReason }` so callers can tell apart \"ran clean\" from \"never ran\"."
                    ),
                burst: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Enable burst screenshot capture for enhanced verification. " +
                        "Captures 4 rapid screenshots (~150ms intervals) after the tap to detect transient visual feedback " +
                        "(press animations, highlights, ripples) that may settle before a standard after-screenshot. " +
                        "Results are stored in the image buffer (use get_images to inspect individual frames). " +
                        "Default: false."
                    ),
            },
        },
        async (args: any) => {
            const result: TapResult = await tap({
                text: args.text,
                testID: args.testID,
                component: args.component,
                index: args.index,
                x: args.x,
                y: args.y,
                strategy: args.strategy,
                maxTraversalDepth: args.maxTraversalDepth,
                native: args.native,
                platform: args.platform,
                device: args.device,
                udid: args.udid,
                screenshot: args.screenshot,
                verify: args.verify,
                burst: args.burst,
            });
    
            const { screenshot: screenshotData, ...resultWithoutScreenshot } = result;
            const text = JSON.stringify(resultWithoutScreenshot, null, 2);
            // Pack predicate + strategy mode + attempted strategies into errorContext for telemetry.
            // Always include the predicate so unmeaningful outcomes (no isError, no _errorMessage) still
            // carry triage context — otherwise blob8 ends up blank and the dashboard shows empty rows.
            // e.g. "p={\"text\":\"Save\"}|s=ocr|fiber:no_pressable|ocr:no_match"
            const stratPrefix = args.strategy && args.strategy !== "auto" ? `s=${args.strategy}|` : "";
            let predicatePrefix = "";
            try {
                if (result.query !== undefined) {
                    predicatePrefix = `p=${JSON.stringify(result.query)}|`;
                }
            } catch {
                // query may contain non-serializable values — drop the prefix rather than fail.
            }
            const attemptedPart = result.attempted?.length
                ? result.attempted.map(a => `${a.strategy}:${a.reason.slice(0, 40)}`).join("|")
                : "";
            const ctxParts = `${predicatePrefix}${stratPrefix}${attemptedPart}`;
            const errorContext = ctxParts ? ctxParts.replace(/\|$/, "") : undefined;
    
            const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
                { type: "text" as const, text },
            ];
    
            if (screenshotData) {
                content.push({
                    type: "image" as const,
                    data: screenshotData.image,
                    mimeType: "image/jpeg",
                });
            }
    
            return {
                content,
                isError: !result.success && !result.ambiguous,
                _errorMessage: !result.success && !result.ambiguous
                    ? `${JSON.stringify(result.query)}|${result.error || ""}`
                    : undefined,
                _errorContext: errorContext,
                _meaningful: result.verification?.meaningful,
                _changeRate: result.verification?.changeRate,
                _tapStrategy: result.method,
                _iosDriver: result.platform === "ios" ? (process.env.IOS_DRIVER?.toLowerCase() || "axe") : undefined,
                _artifactKey: result.artifactKey,
                _ocrClosestMatch: result.ocrClosestMatch,
                _fiberPressableCount: result.fiberPressableCount,
                _accessibilityMatchCount: result.accessibilityMatchCount,
                _appRoute: result.appRoute,
            };
        }
    );
    // Android UI Input Tools (Phase 2)
    // ============================================================================
    
    // Tool: Android long press
    registerToolWithTelemetry(
        server,
        "android_long_press",
        {
            description: "Long press at specific coordinates on an Android device/emulator screen" +
                platformFallbackBanner("`tap` for short taps; keep android_long_press for long-press gestures specifically") +
                "\nPURPOSE: Emit a sustained touch at raw pixel coordinates to trigger long-press handlers (context menus, drag starts, multi-select)." +
                "\nWHEN TO USE: Only when a long-press gesture is required — regular taps should go through `tap`." +
                "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                x: z.coerce.number().describe("X coordinate in pixels"),
                y: z.coerce.number().describe("Y coordinate in pixels"),
                durationMs: z.number().optional().default(1000).describe("Press duration in milliseconds (default: 1000)"),
                deviceId: z
                    .string()
                    .optional()
                    .describe("Optional device ID. Uses first available device if not specified.")
            }
        },
        async ({ x, y, durationMs, deviceId }) => {
            const result = await androidLongPress(x, y, durationMs, deviceId);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: Android swipe
    registerToolWithTelemetry(
        server,
        "android_swipe",
        {
            description: "Swipe from one point to another on an Android device/emulator screen" +
                platformFallbackBanner("`tap` for targeted interactions; keep android_swipe for raw-coordinate gestures") +
                "\nPURPOSE: Perform a raw-coordinate swipe gesture for scrolling, paging, dismissing sheets, or drawer opens on Android." +
                "\nWHEN TO USE: When you need a gesture rather than a tap — scroll lists, swipe carousels, or pull-to-refresh." +
                "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                startX: z.coerce.number().describe("Starting X coordinate in pixels"),
                startY: z.coerce.number().describe("Starting Y coordinate in pixels"),
                endX: z.coerce.number().describe("Ending X coordinate in pixels"),
                endY: z.coerce.number().describe("Ending Y coordinate in pixels"),
                durationMs: z.number().optional().default(300).describe("Swipe duration in milliseconds (default: 300)"),
                deviceId: z
                    .string()
                    .optional()
                    .describe("Optional device ID. Uses first available device if not specified.")
            }
        },
        async ({ startX, startY, endX, endY, durationMs, deviceId }) => {
            const result = await androidSwipe(startX, startY, endX, endY, durationMs, deviceId);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: Android input text
    registerToolWithTelemetry(
        server,
        "android_input_text",
        {
            description:
                "Type text on an Android device/emulator." +
                platformFallbackBanner("`tap(text=...)` — it auto-focuses TextInput via the fiber tree") +
                " The text will be input at the current focus point (tap an input field first)." +
                "\nPURPOSE: Send keystrokes to whichever input currently has focus on Android — the tool does NOT focus a field itself." +
                "\nWHEN TO USE: Only after an input is already focused, or when `tap(text=...)` on the input didn't take focus for some reason." +
                "\nREPLACE MODE: pass replace:true to clear the focused field first (via React onChangeText so controlled state stays consistent), then type the new value. Use for pre-filled fields where appending would corrupt the value." +
                "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                text: z.string().describe("Text to type"),
                replace: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, clear the focused TextInput via React onChangeText before typing. Use to set a pre-filled field to an exact value without concatenation. Requires Bridgeless/Fabric."
                    ),
                device: z
                    .string()
                    .optional()
                    .describe(
                        "Optional RN device name (substring match) — needed by replace:true when multiple RN apps are connected, to disambiguate which device's focused input to clear. Single-device sessions can omit."
                    ),
                deviceId: z
                    .string()
                    .optional()
                    .describe("Optional device ID. Uses first available device if not specified.")
            }
        },
        async ({ text, replace, device, deviceId }) => {
            const result = await inputTextWithReplace(
                text,
                replace === true,
                (t) => androidInputText(t, deviceId),
                () => clearFocusedInput(device)
            );
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: Android key event
    registerToolWithTelemetry(
        server,
        "android_key_event",
        {
            description: "Send a key event to an Android device/emulator." +
                platformUniqueBanner("sending Android key events (BACK, HOME, MENU, etc.)") +
                ` Common keys: ${Object.keys(ANDROID_KEY_EVENTS).join(", ")}` +
                "\nPURPOSE: Dispatch Android system keys (BACK, HOME, MENU, ENTER, DEL, etc.) that aren't reachable via on-screen tap." +
                "\nWHEN TO USE: Navigate back from a screen, submit a form with ENTER, dismiss the keyboard, or press hardware-style keys during a flow." +
                "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                key: z.string().describe(`Key name (${Object.keys(ANDROID_KEY_EVENTS).join(", ")}) or numeric keycode`),
                deviceId: z
                    .string()
                    .optional()
                    .describe("Optional device ID. Uses first available device if not specified.")
            }
        },
        async ({ key, deviceId }) => {
            // Try to parse as number first, otherwise treat as key name
            const keyCode = /^\d+$/.test(key) ? parseInt(key, 10) : (key.toUpperCase() as keyof typeof ANDROID_KEY_EVENTS);
    
            const result = await androidKeyEvent(keyCode, deviceId);
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    
    // ============================================================================
    // Android Accessibility Tools (UI Hierarchy)
    // ============================================================================
    // ============================================================================
    // iOS Simulator Tools
    // ============================================================================
    
    
    
    // Tool: iOS install app
    
    // ============================================================================
    // iOS UI Interaction Tools (require an iOS UI driver)
    // Default: AXe — brew install cameroncooke/axe/axe
    // Alternative: IDB — brew install idb-companion (set IOS_DRIVER=idb)
    // ============================================================================
    // Tool: iOS button
    server.registerTool(
        "ios_button",
        {
            description:
                "Press a hardware button on an iOS simulator." +
                platformUniqueBanner("pressing iOS hardware buttons (HOME, LOCK, SIRI, APPLE_PAY)") +
                " Requires an iOS UI driver: AXe (recommended: brew install cameroncooke/axe/axe) or IDB (brew install idb-companion)." +
                "\nPURPOSE: Trigger iOS hardware buttons (HOME, LOCK, SIDE_BUTTON, SIRI, APPLE_PAY) that aren't reachable via on-screen tap." +
                "\nWHEN TO USE: Send the app to background (HOME), lock the simulator (LOCK), or exercise Siri/Apple Pay flows." +
                "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                button: z
                    .enum(IOS_BUTTON_TYPES)
                    .describe("Hardware button to press: HOME, LOCK, SIDE_BUTTON, SIRI, or APPLE_PAY"),
                duration: z.coerce.number().optional().describe("Optional button press duration in seconds"),
                udid: z.string().optional().describe("Optional simulator UDID. Uses booted simulator if not specified.")
            }
        },
        async ({ button, duration, udid }) => {
            const result = await iosButton(button, { duration, udid });
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: Clear focused text input
    registerToolWithTelemetry(
        server,
        "clear_focused_input",
        {
            description:
                "Clear the contents of the currently focused TextInput, updating React state correctly so controlled components (Formik, react-hook-form, useState) stay consistent." +
                "\nPURPOSE: Reset whatever TextInput has focus to empty, with the React state owner notified via onChangeText. Use BEFORE typing a replacement value into a pre-filled field." +
                "\nWHEN TO USE: After tap(testID=...) focuses an input that already has text. Pair with ios_input_text/android_input_text (or use their replace:true flag for one-shot)." +
                "\nLIMITATIONS: Requires Bridgeless/Fabric (RN new architecture). Returns 'no focused TextInput' if nothing is focused — does not silently no-op." +
                "\nSEE ALSO: dismiss_keyboard, ios_input_text({replace:true}), android_input_text({replace:true}). call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                device: z
                    .string()
                    .optional()
                    .describe("Optional device name (substring match). Uses default device if not specified.")
            }
        },
        async ({ device }) => {
            const result = await clearFocusedInput(device);
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? `Cleared focused input (via ${result.via}).` : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: Dismiss keyboard
    registerToolWithTelemetry(
        server,
        "dismiss_keyboard",
        {
            description:
                "Blur the currently focused TextInput, dismissing the on-screen keyboard." +
                "\nPURPOSE: Close the keyboard when it's blocking content beneath the input, or move focus off an input before a tap that would otherwise be intercepted." +
                "\nWHEN TO USE: After typing into a field and before tapping a button that is hidden by the keyboard. Or to verify a 'tap outside dismisses' UX is wired up." +
                "\nLIMITATIONS: Requires Bridgeless/Fabric (RN new architecture). Returns 'no focused TextInput' if nothing is focused.",
            inputSchema: {
                device: z
                    .string()
                    .optional()
                    .describe("Optional device name (substring match). Uses default device if not specified.")
            }
        },
        async ({ device }) => {
            const result = await dismissKeyboard(device);
            return {
                content: [
                    {
                        type: "text",
                        text: result.success
                            ? `Dismissed keyboard (nativeTag ${result.nativeTag}).`
                            : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
    
    // Tool: iOS input text
    registerToolWithTelemetry(
        server,
        "ios_input_text",
        {
            description:
                "Type text on an iOS simulator." +
                platformFallbackBanner("`tap(text=...)` — it auto-focuses TextInput via the fiber tree") +
                " The text is typed into whichever field currently has focus (tap an input first). Mirrors `android_input_text` so cross-platform agents can use `<platform>_input_text` without branching on the iOS driver shell-out." +
                "\nPURPOSE: Send keystrokes to the focused field on an iOS simulator via the active UI driver (AXe — preferred — or IDB)." +
                "\nWHEN TO USE: Only after an input is already focused, or when `tap(testID=...)` on the input didn't take focus for some reason. Use the testID-first flow whenever possible — it's faster and survives UI repositioning." +
                "\nREPLACE MODE: pass replace:true to clear the focused field first (via React onChangeText so controlled state stays consistent), then type the new value. Use for pre-filled fields where appending would corrupt the value." +
                "\nLIMITATIONS: AXe types via the US-keyboard HID — non-ASCII characters (Cyrillic, CJK, Arabic) may not transmit correctly. If the active driver is AXe and the text contains non-ASCII chars, prefer pasting via the simulator pasteboard or setting IOS_DRIVER=idb." +
                "\nSEE ALSO: call get_usage_guide(topic=\"interact\") for the full UI-interaction playbook.",
            inputSchema: {
                text: z.string().describe("Text to type into the currently focused field."),
                replace: z
                    .boolean()
                    .optional()
                    .describe(
                        "If true, clear the focused TextInput via React onChangeText before typing. Use to set a pre-filled field to an exact value without concatenation. Requires Bridgeless/Fabric."
                    ),
                device: z
                    .string()
                    .optional()
                    .describe(
                        "Optional RN device name (substring match) — needed by replace:true when multiple RN apps are connected, to disambiguate which device's focused input to clear. Single-device sessions can omit."
                    ),
                udid: z.string().optional().describe("Optional simulator UDID (from list_ios_simulators). Uses booted simulator if not specified.")
            }
        },
        async ({ text, replace, device, udid }) => {
            const result = await inputTextWithReplace(
                text,
                replace === true,
                (t) => iosInputText(t, udid),
                () => clearFocusedInput(device)
            );
    
            return {
                content: [
                    {
                        type: "text",
                        text: result.success ? result.result! : `Error: ${result.error}`
                    }
                ],
                isError: !result.success
            };
        }
    );
}
