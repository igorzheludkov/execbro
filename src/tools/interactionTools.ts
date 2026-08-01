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
    iosSwipe,
    IOS_BUTTON_TYPES,
    getDevicePixelRatio,
    connectedApps,
} from "../core/index.js";
import { tap, convertScreenshotToTapCoords, computeSwipeFromDirection, type SwipeDirection, type TapResult } from "../pro/tap.js";
import {
    captureScreenshot,
    verifyAndCapture,
    burstCaptureAndVerify,
} from "../pro/verifyAction.js";
import { clearFocusedInput, dismissKeyboard, inputTextWithReplace } from "../core/focusedInputTools.js";
import { enterText, type TextEntryResult } from "../core/textEntry.js";
import { runInputOp } from "../core/inputTargetTools.js";
import { raiseKeyboard } from "../core/keyboardRaise.js";
import { primaryInteractionBanner, platformFallbackBanner, platformUniqueBanner } from "../core/toolHelpers.js";
import { resolveDeviceTarget, formatResolverError } from "../core/deviceResolver.js";
import { resolveAndroidDeviceId, resolveIosUdid, ANDROID_ARG_DESC, IOS_ARG_DESC } from "./_deviceArg.js";
import type { ConnectedApp } from "../core/types.js";

/**
 * Default swipe gesture duration. Android has always used 300ms; iOS passed no
 * duration at all and inherited AXe's ~1s drag, which was both slower and too
 * slow to trigger inertial scrolling. Shared so the platforms cannot drift again.
 */
export const SWIPE_DEFAULT_DURATION_MS = 300;

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
                "LIMITATIONS: iOS needs AXe (brew install cameroncooke/axe/axe) or IDB for accessibility/coordinate taps. Non-ASCII text skips fiber (Hermes); prefer testID. Pass `device` to target a specific simulator/emulator when multiple are available — call list_devices for the inventory.\n" +
                "GOOD: tap({ testID: \"login-btn\" }); tap({ text: \"Submit\" }); tap({ x: 300, y: 600 }); tap({ x: 300, y: 600, native: true, device: \"emulator-5554\" })\n" +
                "BAD: tap({ text: \"\" }) or tap({ x: 0, y: 0 }) — missing a target. tap({ text: \"Submit\" }) without first screenshotting an ambiguous screen.\n" +
                "SOURCE: need the file:line that renders an element? inspect_at_point(x, y).\n",
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
                device: z
                    .string()
                    .optional()
                    .describe(
                        "Target device. Accepts (a) an iOS simulator UDID, " +
                        "(b) an Android adb serial like 'emulator-5554', " +
                        "(c) the iOS simulator or Android emulator/device name (substring match), or " +
                        "(d) a connected RN app's deviceName (substring match against get_apps output). " +
                        "Omit when exactly one device is available. Call list_devices to enumerate."
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
                device: args.device,
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
                "\nWHEN TO USE: Only when a long-press gesture is required — regular taps should go through `tap`.",
            inputSchema: {
                x: z.coerce.number().describe("X coordinate in pixels"),
                y: z.coerce.number().describe("Y coordinate in pixels"),
                durationMs: z.number().optional().default(1000).describe("Press duration in milliseconds (default: 1000)"),
                deviceId: z
                    .string()
                    .optional()
                    .describe(ANDROID_ARG_DESC)
            }
        },
        async ({ x, y, durationMs, deviceId }) => {
            const r = await resolveAndroidDeviceId(deviceId);
            if (!r.ok) return r.response;
            const result = await androidLongPress(x, y, durationMs, r.serial);
    
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
    
    // Tool: Cross-platform swipe — auto-routes to iOS or Android backend
    registerToolWithTelemetry(
        server,
        "swipe",
        {
            description:
                "Swipe gesture that auto-routes to the correct platform (iOS or Android), with pixel-diff verification." +
                primaryInteractionBanner() + "\n" +
                "PURPOSE: Single unified swipe entry point. Easiest form: swipe({ direction: \"up\" }) scrolls to reveal more content (\"down\"/\"left\"/\"right\" also work; bare swipe() defaults to \"up\"). Optional distance in screenshot pixels (default 33% of axis). For precise control, pass all four coordinates (startX/startY/endX/endY) — they take precedence over direction.\n" +
                "WHEN TO USE: Scrolling lists, paging carousels, pull-to-refresh, dismissing sheets, opening drawers — anything that needs a gesture rather than a tap. Especially useful in virtualized lists (FlatList/SectionList) where off-screen items aren't mounted in the fiber tree.\n" +
                "VERIFICATION: verify=true (default) returns `verification.meaningful` — false means the scroll did nothing (end-of-list, non-scrollable surface, or missed coordinates). burst=true catches transient feedback like overscroll bounce.\n" +
                "WORKFLOW: swipe({ direction: \"up\" }) -> read response.verification.meaningful. Advanced: pass startX/startY/endX/endY for coordinate-precise gestures.\n" +
                "LIMITATIONS: iOS needs AXe (brew install cameroncooke/axe/axe) or IDB. Pass `device` to target a specific simulator/emulator when multiple are available — call list_devices for the inventory.\n",
            inputSchema: {
                direction: z
                    .enum(["up", "down", "left", "right"])
                    .optional()
                    .describe(
                        "Shorthand for a centered scroll gesture (content-scroll semantics): " +
                        "\"up\" reveals content below (finger moves bottom→top), \"down\" reveals content above, " +
                        "\"left\"/\"right\" page horizontally. A bare swipe() with no params defaults to \"up\". " +
                        "Ignored when all four explicit coordinates are provided."
                    ),
                distance: z.coerce
                    .number()
                    .positive()
                    .optional()
                    .describe("Travel length in screenshot pixels for the direction shorthand. Default: 33% of the relevant screen axis."),
                startX: z.coerce.number().optional().describe("Starting X coordinate in screenshot pixels (explicit-coordinate mode)"),
                startY: z.coerce.number().optional().describe("Starting Y coordinate in screenshot pixels (explicit-coordinate mode)"),
                endX: z.coerce.number().optional().describe("Ending X coordinate in screenshot pixels (explicit-coordinate mode)"),
                endY: z.coerce.number().optional().describe("Ending Y coordinate in screenshot pixels (explicit-coordinate mode)"),
                durationMs: z.coerce
                    .number()
                    .optional()
                    .describe("Swipe duration in milliseconds (default: 300 on Android; iOS uses driver default if omitted)"),
                delta: z.coerce
                    .number()
                    .optional()
                    .describe("iOS only — touch step size between events (driver-dependent default). Ignored on Android."),
                device: z
                    .string()
                    .optional()
                    .describe(
                        "Target device. Accepts (a) an iOS simulator UDID, " +
                        "(b) an Android adb serial like 'emulator-5554', " +
                        "(c) the iOS simulator or Android emulator/device name (substring match), or " +
                        "(d) a connected RN app's deviceName (substring match against get_apps output). " +
                        "Omit when exactly one device is available. Call list_devices to enumerate."
                    ),
                verify: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "Compare before/after screenshots to detect whether the swipe produced a visual change. " +
                        "Set false to skip. When skipped, the response contains `verification: { skipped: true, skippedReason }` " +
                        "so callers can tell apart \"ran clean\" from \"never ran\"."
                    ),
                screenshot: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "Return the post-swipe image bytes in the response. Default true. Set to false to drop the PNG bytes — " +
                        "verification still runs (set verify=false to skip that too)."
                    ),
                burst: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Capture rapid sequential frames after the swipe to detect transient feedback (overscroll bounce, " +
                        "fling-then-snap-back) even when the final state is unchanged. Frames are stored in the image buffer; " +
                        "use get_images(groupId=verification.burstGroupId) to retrieve them."
                    ),
            }
        },
        async ({ direction, distance, startX, startY, endX, endY, durationMs, delta, device, verify, screenshot, burst }) => {
            const resolved = await resolveDeviceTarget(device);
            if (!resolved.ok) {
                return {
                    content: [{ type: "text", text: `Error: ${formatResolverError(resolved.error)}` }],
                    isError: true
                };
            }
            const resolvedPlatform: "ios" | "android" = resolved.target.platform;
            const resolvedUdid: string | undefined = resolved.target.iosUdid;

            const shouldVerify = verify !== false;
            const shouldScreenshot = screenshot !== false;
            const shouldBurst = burst === true;

            const coordCount = [startX, startY, endX, endY].filter((v) => v !== undefined).length;
            const hasAllCoords = coordCount === 4;
            const useDirection = !hasAllCoords;
            // Partial coordinates are only an error when no direction was given; an
            // explicit direction takes the shorthand path and ignores stray coords.
            if (!hasAllCoords && coordCount > 0 && direction === undefined) {
                return {
                    content: [{
                        type: "text",
                        text: "Error: swipe needs either all four coordinates (startX/startY/endX/endY in screenshot pixels) or a direction (up/down/left/right, with optional distance in pixels). Got partial coordinates.",
                    }],
                    isError: true,
                };
            }

            // Capture before-screenshot only if we'll need it (verify or burst).
            const wantBefore = shouldVerify || shouldBurst;
            let beforeCapture = wantBefore
                ? await captureScreenshot(resolvedPlatform!, resolvedUdid)
                : null;

            if (useDirection) {
                // Need screen dimensions to compute the centered gesture. Reuse the
                // before-frame if we captured one; otherwise grab one measurement frame.
                let dims = beforeCapture;
                if (!dims) {
                    dims = await captureScreenshot(resolvedPlatform!, resolvedUdid);
                }
                if (!dims || !dims.width || !dims.height) {
                    return {
                        content: [{
                            type: "text",
                            text: "Error: could not read screen dimensions to compute the swipe gesture. Pass explicit startX/startY/endX/endY coordinates instead.",
                        }],
                        isError: true,
                    };
                }
                const computed = computeSwipeFromDirection(
                    (direction ?? "up") as SwipeDirection,
                    distance,
                    dims.width,
                    dims.height
                );
                startX = computed.startX;
                startY = computed.startY;
                endX = computed.endX;
                endY = computed.endY;
            }

            const beforeBuffer = beforeCapture?.buffer ?? null;
            const beforeScaleFactor = beforeCapture?.scaleFactor;

            // Prefer the scale factor of the frame captured for THIS device this
            // turn over `connectedApps[0].lastScreenshot`, which may be stale or
            // belong to another device on a multi-device setup — the same fix tap
            // carries for its coordinate strategy (Bug #5, 2026-05-20).
            const swipeScaleFactor =
                beforeCapture?.scaleFactor
                ?? (connectedApps.values().next().value as ConnectedApp | undefined)?.lastScreenshot?.scaleFactor
                ?? 1;
            const dprHint = beforeCapture && beforeCapture.width > 0 && beforeCapture.height > 0
                ? { width: beforeCapture.width, height: beforeCapture.height }
                : undefined;

            let driverResult: { success: boolean; result?: string; error?: string };
            if (resolvedPlatform === "ios") {
                const dpr = await getDevicePixelRatio(resolvedUdid, dprHint);
                const start = convertScreenshotToTapCoords(startX, startY, "ios", dpr, swipeScaleFactor);
                const end = convertScreenshotToTapCoords(endX, endY, "ios", dpr, swipeScaleFactor);
                // Without an explicit duration, AXe drags for ~1s (measured
                // 2026-08-01) — slower than the Android path, which has always
                // defaulted to 300ms, and slow enough that iOS never produced the
                // inertial fling a real scroll gesture has. Default both platforms
                // to the same 300ms flick.
                const duration = (durationMs ?? SWIPE_DEFAULT_DURATION_MS) / 1000;
                driverResult = await iosSwipe(start.x, start.y, end.x, end.y, { duration, delta, udid: resolvedUdid });
            } else {
                const start = convertScreenshotToTapCoords(startX, startY, "android", 1, swipeScaleFactor);
                const end = convertScreenshotToTapCoords(endX, endY, "android", 1, swipeScaleFactor);
                driverResult = await androidSwipe(start.x, start.y, end.x, end.y, durationMs ?? SWIPE_DEFAULT_DURATION_MS, resolved.target.androidSerial);
            }

            if (!driverResult.success) {
                return {
                    content: [{ type: "text", text: `Error: ${driverResult.error}` }],
                    isError: true
                };
            }

            // Driver succeeded — run verification.
            const verifyResult = shouldBurst
                ? await burstCaptureAndVerify({
                    platform: resolvedPlatform!,
                    beforeBuffer,
                    udid: resolvedUdid,
                    beforeScaleFactor,
                    source: "swipe-burst",
                })
                : await verifyAndCapture({
                    platform: resolvedPlatform!,
                    shouldVerify,
                    shouldScreenshot,
                    beforeBuffer,
                    udid: resolvedUdid,
                    beforeScaleFactor,
                    source: "swipe-verify",
                });

            const { screenshot: screenshotData, verification } = verifyResult;

            const warning =
                verification && !verification.skipped && verification.meaningful === false
                    ? "Swipe executed but no visual change detected — list may be at end-of-scroll, content is non-scrollable, or the gesture missed the scroll surface. Inspect the screenshot and retry with adjusted coordinates if needed."
                    : undefined;

            const responseBody: Record<string, unknown> = {
                success: true,
                platform: resolvedPlatform,
                from: { x: startX, y: startY },
                to: { x: endX, y: endY },
                driverMessage: driverResult.result,
                ...(verification && { verification }),
                ...(warning && { warning }),
                deviceNote: resolved.note,
            };

            const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
                { type: "text" as const, text: JSON.stringify(responseBody, null, 2) },
            ];

            if (shouldScreenshot && screenshotData) {
                content.push({
                    type: "image" as const,
                    data: screenshotData.image,
                    mimeType: "image/jpeg",
                });
            }

            return {
                content,
                isError: false,
                _meaningful: verification && !verification.skipped ? verification.meaningful : undefined,
                _changeRate: verification && !verification.skipped ? verification.changeRate : undefined,
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
                platformFallbackBanner("`input_text` — it targets, focuses, writes and verifies in one call") +
                " The text will be input at the current focus point (tap an input field first)." +
                "\nPURPOSE: Send keystrokes to whichever input currently has focus on Android — the tool does NOT focus a field itself." +
                "\nWHEN TO USE: Only after an input is already focused, or when `tap(text=...)` on the input didn't take focus for some reason." +
                "\nPREREQUISITE: A TextInput must already have focus. Tap the field first (e.g. tap({ testID: 'search' })) — `android_input_text` does NOT focus a field itself; replace:true also requires React focus." +
                "\nREPLACE MODE: pass replace:true to clear the focused field first (via React onChangeText so controlled state stays consistent), then type the new value. Use for pre-filled fields where appending would corrupt the value.",
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
                    .describe(ANDROID_ARG_DESC)
            }
        },
        async ({ text, replace, device, deviceId }) => {
            const r = await resolveAndroidDeviceId(deviceId);
            if (!r.ok) return r.response;
            const result = await inputTextWithReplace(
                text,
                replace === true,
                (t) => androidInputText(t, r.serial),
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
                "\nWHEN TO USE: Navigate back from a screen, submit a form with ENTER, dismiss the keyboard, or press hardware-style keys during a flow.",
            inputSchema: {
                key: z.string().describe(`Key name (${Object.keys(ANDROID_KEY_EVENTS).join(", ")}) or numeric keycode`),
                deviceId: z
                    .string()
                    .optional()
                    .describe(ANDROID_ARG_DESC)
            }
        },
        async ({ key, deviceId }) => {
            // Try to parse as number first, otherwise treat as key name
            const keyCode = /^\d+$/.test(key) ? parseInt(key, 10) : (key.toUpperCase() as keyof typeof ANDROID_KEY_EVENTS);

            const r = await resolveAndroidDeviceId(deviceId);
            if (!r.ok) return r.response;
            const result = await androidKeyEvent(keyCode, r.serial);
    
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
                "\nWHEN TO USE: Send the app to background (HOME), lock the simulator (LOCK), or exercise Siri/Apple Pay flows.",
            inputSchema: {
                button: z
                    .enum(IOS_BUTTON_TYPES)
                    .describe("Hardware button to press: HOME, LOCK, SIDE_BUTTON, SIRI, or APPLE_PAY"),
                duration: z.coerce.number().optional().describe("Optional button press duration in seconds"),
                udid: z.string().optional().describe(IOS_ARG_DESC)
            }
        },
        async ({ button, duration, udid }) => {
            const r = await resolveIosUdid(udid);
            if (!r.ok) return r.response;
            const result = await iosButton(button, { duration, udid: r.udid });
    
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
    // Tool: Dismiss keyboard
    registerToolWithTelemetry(
        server,
        "dismiss_keyboard",
        {
            description:
                "Blur the currently focused TextInput, dismissing the on-screen keyboard." +
                "\nPURPOSE: Close the keyboard when it's blocking content beneath the input, or move focus off an input before a tap that would otherwise be intercepted." +
                "\nWHEN TO USE: After typing into a field and before tapping a button that is hidden by the keyboard. Or to verify a 'tap outside dismisses' UX is wired up." +
                "\nPREREQUISITE: A TextInput must already have React focus. Tap the field first (e.g. tap({ testID: 'search' }))." +
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
                platformFallbackBanner("`input_text` — it targets, focuses, writes and verifies in one call") +
                " The text is typed into whichever field currently has focus (tap an input first). Mirrors `android_input_text` so cross-platform agents can use `<platform>_input_text` without branching on the iOS driver shell-out." +
                "\nPURPOSE: Send keystrokes to the focused field on an iOS simulator via the active UI driver (AXe — preferred — or IDB)." +
                "\nWHEN TO USE: Only after an input is already focused, or when `tap(testID=...)` on the input didn't take focus for some reason. Use the testID-first flow whenever possible — it's faster and survives UI repositioning." +
                "\nREPLACE MODE: pass replace:true to clear the focused field first (via React onChangeText so controlled state stays consistent), then type the new value. Use for pre-filled fields where appending would corrupt the value." +
                "\nLIMITATIONS: AXe types via the US-keyboard HID — non-ASCII characters (Cyrillic, CJK, Arabic) may not transmit correctly. If the active driver is AXe and the text contains non-ASCII chars, prefer pasting via the simulator pasteboard or setting IOS_DRIVER=idb.",
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
                udid: z.string().optional().describe(IOS_ARG_DESC)
            }
        },
        async ({ text, replace, device, udid }) => {
            const r = await resolveIosUdid(udid);
            if (!r.ok) return r.response;
            const result = await inputTextWithReplace(
                text,
                replace === true,
                (t) => iosInputText(t, r.udid),
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

    // Tool: cross-platform text entry
    registerToolWithTelemetry(
        server,
        "input_text",
        {
            description:
                "Write text into a React Native TextInput and verify it landed." +
                primaryInteractionBanner() +
                "\nPURPOSE: Set a field's text and confirm, by reading the value back, that the field holds exactly what you sent." +
                "\nWHEN TO USE: Any text entry in a React Native app. Pass testID (or component/textMatch) and this tool focuses the field itself — no separate tap needed." +
                "\nWORKFLOW: get_screen_state to see the fields -> input_text({ testID, text }) -> read `verified`.\n" +
                "VERIFICATION: the write is read back and compared EXACTLY. A mismatch retries once, then fails with `sent` vs `landed`. A success means the field really holds your string.\n" +
                "AMBIGUITY: if the target matches several inputs the tool refuses and returns a numbered candidate list (label, placeholder, value, testID) — pick one with `index` rather than guessing. Forms routinely share a placeholder across every field.\n" +
                "KEYBOARD: after the text is in, the software keyboard is raised on a best-effort basis so keyboard-up layout can be inspected. Failure there is reported, never fatal.\n" +
                "LIMITATIONS: fields with no onChangeText (uncontrolled, or non-RN) fall back to the platform driver, which is US-keyboard only — non-ASCII fails there and the result may be verified:false.\n" +
                "GOOD: input_text({ testID: \"new-topic-title\", text: \"Q3 budget\", replace: true })\n" +
                "BAD: input_text({ text: \"...\" }) with nothing focused — pass a target instead.\n",
            inputSchema: {
                text: z.string().describe("The text to write into the field."),
                testID: z
                    .string()
                    .optional()
                    .describe("Target the input with this testID. Most reliable — the tool focuses it itself, no prior tap needed."),
                component: z
                    .string()
                    .optional()
                    .describe("Target by React component name (case-insensitive substring), e.g. 'FormInput'. Use when there is no testID."),
                textMatch: z
                    .string()
                    .optional()
                    .describe("Target by the field's visible label, placeholder, or current value (case-insensitive substring). NOTE: this picks WHICH field to write to; `text` is what gets written."),
                index: z
                    .number()
                    .optional()
                    .describe("Zero-based choice when the target matches several inputs. The response's candidate list gives the indexes."),
                replace: z
                    .boolean()
                    .optional()
                    .describe("Replace the field's contents instead of appending. Default false (append)."),
                device: z
                    .string()
                    .optional()
                    .describe("RN device name (substring match). Omit when one app is connected; see get_apps.")
            }
        },
        async ({ text, testID, component, textMatch, index, replace, device }) => {
            const resolved = await resolveDeviceTarget(device);
            if (!resolved.ok) {
                return {
                    content: [{ type: "text" as const, text: `Error: ${formatResolverError(resolved.error)}` }],
                    isError: true
                };
            }

            const { platform, iosUdid, androidSerial } = resolved.target;

            const result = await enterText(
                { text, testID, component, textMatch, index, replace, device },
                {
                    runOp: (op, query, dev) => runInputOp(op, query, dev),
                    typeHid: async (t) =>
                        platform === "ios" ? await iosInputText(t, iosUdid) : await androidInputText(t, androidSerial),
                    raise: () => raiseKeyboard(platform, platform === "ios" ? iosUdid : androidSerial)
                }
            );

            return formatTextEntryResponse(result);
        }
    );
}

/**
 * Renders a text-entry outcome. Two rules carry the whole design:
 * an unverified write must never read as a plain success, and a failed
 * keyboard raise must never read as a failed write.
 */
export function formatTextEntryResponse(r: TextEntryResult): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
} {
    const lines: string[] = [];

    if (r.success) {
        lines.push(
            r.verified
                ? `Set to ${JSON.stringify(r.value)} (${r.path}, verified${r.retried ? ", retried once" : ""}).`
                : `Wrote via ${r.path} but UNVERIFIED — ${r.error ?? "the value could not be read back"}.`
        );
    } else {
        lines.push(`Error: ${r.error ?? "text entry failed"}`);
        if (r.sent !== undefined) lines.push(`  sent:   ${JSON.stringify(r.sent)}`);
        if (r.landed !== undefined) lines.push(`  landed: ${JSON.stringify(r.landed)}`);
        if (r.candidates?.length) {
            lines.push(r.ambiguous ? "  matching inputs:" : "  inputs on screen:");
            for (const c of r.candidates) {
                const bits = [
                    c.label ? `label:${JSON.stringify(c.label)}` : null,
                    c.placeholder ? `placeholder:${JSON.stringify(c.placeholder)}` : null,
                    c.value ? `value:${JSON.stringify(c.value)}` : null,
                    c.testID ? `testID:${JSON.stringify(c.testID)}` : null,
                    c.component ? `<${c.component} />` : null
                ].filter(Boolean);
                lines.push(`    ${c.index}: ${bits.join(" ")}`);
            }
            if (r.ambiguous) lines.push("  Re-run with index: <n>, or target more precisely.");
        }
    }

    if (r.keyboard) {
        lines.push(
            r.keyboard.raised
                ? `  keyboard: visible${r.keyboard.changed ? " (raised)" : ""}`
                : `  keyboard: not raised — ${r.keyboard.reason ?? "unknown"}`
        );
    }

    return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        ...(r.success ? {} : { isError: true })
    };
}
