import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { resolveAndroidDeviceId, resolveIosUdid } from "./_deviceArg.js";
import { iconLabel } from "../core/iconSemantics.js";
import {
    iosScreenshot,
    androidScreenshot,
    detectLogBox,
    formatLogBoxWarning,
    recognizeText,
    inferIOSDevicePixelRatio,
    getPressableElements,
    getScreenState,
    formatScreenStateSummary,
    imageBuffer,
    getActiveOrBootedSimulatorUdid,
    enrichScreenshotWithLayout,
    connectedApps,
    getConnectedAppBySimulatorUdid,
    getConnectedAppByAndroidDeviceId,
    iosDescribeAll,
    detectIOSSystemOverlay,
    formatIOSSystemOverlayWarning,
    androidGetStatusBarHeight,
    androidGetDensity,
} from "../core/index.js";
import { getJpegDimensions, estimateImageTokens } from "../core/toolHelpers.js";

export function registerScreenshotTools(server: McpServer): void {
    // Tool: iOS screenshot
    registerToolWithTelemetry(
        server,
        "ios_screenshot",
        {
            description: "Take a screenshot from an iOS simulator. Returns the image plus a screen-state summary: active route (name + navigation stack), overlay-grouped tappable elements (pressables behind an open sheet/modal are excluded), component names as JSX tags, labels, testIDs, and frames — all in ready-to-tap pixel coordinates. Prefer tap(text=\"...\") when text is exact and unique; otherwise use tap(x, y) with coordinates from the list — this is the most reliable way to tap icons or visually-identified elements. Use component names for inspect_component/find_components.\n" +
                "PURPOSE: Snapshot what the user sees on iOS AND get tap-ready pressables + a structured component map in one call.\n" +
                "WHEN TO USE: Any visual verification, before/after comparison, or as the starting point for tapping UI by coordinates.\n" +
                "WORKFLOW: ios_screenshot -> pick element from pressables -> tap(x, y) or tap(testID=...) -> ios_screenshot to verify.\n" +
                "LIMITATIONS: Requires a booted iOS simulator (simctl). For physical devices or system dialogs without RN, combine with tap(..., native=true).\n" +
                "GOOD: ios_screenshot()\n" +
                "BAD: ios_screenshot({ udid: \"guess\" }) with a made-up UDID — run list_ios_simulators first.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
            inputSchema: {
                outputPath: z
                    .string()
                    .optional()
                    .describe("Optional path to save the screenshot. If not provided, saves to temp directory."),
                udid: z
                    .string()
                    .optional()
                    .describe("Optional iOS target. Accepts a simulator UDID, the simulator name (e.g. 'iPhone 17 Pro'), or a substring of the connected RN device name. Uses booted simulator if not specified."),
                device: z
                    .string()
                    .optional()
                    .describe("Alias for `udid` — same accepted values. Provided for consistency with tap/get_screen_layout/get_screen_state, which all use `device`. If both are given, `udid` wins.")
            }
        },
        async ({ outputPath, udid, device }) => {
            const resolved = await resolveIosUdid(udid ?? device);
            if (!resolved.ok) return resolved.response;
            // Resolve ONCE to a single canonical UDID and use it for BOTH the
            // framebuffer capture and the pressable/screen-state enrichment, so
            // the pixels and the element list always describe the same simulator.
            // Previously the capture used the fuzzy-resolved UDID while enrichment
            // fell back to the raw arg (getActiveOrBootedSimulatorUdid) — on a
            // multi-sim setup that split the image and the tree across two sims.
            const targetUdid = resolved.udid ?? (await getActiveOrBootedSimulatorUdid());
            const result = await iosScreenshot(outputPath, targetUdid ?? undefined);
    
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: ${result.error}`
                        }
                    ],
                    isError: true
                };
            }
    
            // Include image data if available
            if (result.data) {
                // Build info text with coordinate guidance for iOS
                const pixelWidth = result.originalWidth || 0;
                const pixelHeight = result.originalHeight || 0;
    
                // Resolve the RN app running on THIS simulator so enrichment pulls
                // fiber/layout data from the right app (not the first-connected one,
                // which may belong to a different simulator).
                const resolvedUdid = targetUdid;
                const targetApp = resolvedUdid ? getConnectedAppBySimulatorUdid(resolvedUdid) : null;
                const targetDeviceName = targetApp?.deviceInfo.deviceName;
    
                // Store screenshot metadata on the matching app (not an arbitrary one)
                if (targetApp) {
                    targetApp.lastScreenshot = {
                        originalWidth: pixelWidth,
                        originalHeight: pixelHeight,
                        scaleFactor: result.scaleFactor || 1,
                    };
                }
    
                // Try to get actual screen dimensions and safe area from accessibility tree
                let pointWidth = 0;
                let pointHeight = 0;
                let scaleFactor = 3; // Default to 3x for modern iPhones
                let safeAreaTop = 59; // Default safe area offset
                try {
                    const describeResult = await iosDescribeAll(targetUdid ?? undefined);
                    if (describeResult.success && describeResult.elements && describeResult.elements.length > 0) {
                        // First element is typically the Application with full screen frame
                        const rootElement = describeResult.elements[0];
                        // Try parsed frame first, then parse AXFrame string
                        if (rootElement.frame) {
                            pointWidth = Math.round(rootElement.frame.width);
                            pointHeight = Math.round(rootElement.frame.height);
                            // The frame.y of the root element indicates where content starts (after status bar)
                            if (rootElement.frame.y > 0) {
                                safeAreaTop = Math.round(rootElement.frame.y);
                            }
                        } else if (rootElement.AXFrame) {
                            // Parse format: "{{x, y}, {width, height}}"
                            const match = rootElement.AXFrame.match(
                                /\{\{([\d.]+),\s*([\d.]+)\},\s*\{([\d.]+),\s*([\d.]+)\}\}/
                            );
                            if (match) {
                                const frameY = parseFloat(match[2]);
                                pointWidth = Math.round(parseFloat(match[3]));
                                pointHeight = Math.round(parseFloat(match[4]));
                                if (frameY > 0) {
                                    safeAreaTop = Math.round(frameY);
                                }
                            }
                        }
                        // Calculate actual scale factor
                        if (pointWidth > 0) {
                            scaleFactor = Math.round(pixelWidth / pointWidth);
                        }
                    }
                } catch {
                    // Fallback: use 3x scale for modern devices
                }
    
                // Fallback if we couldn't get dimensions
                if (pointWidth === 0) {
                    pointWidth = Math.round(pixelWidth / scaleFactor);
                    pointHeight = Math.round(pixelHeight / scaleFactor);
                }
    
                const safeAreaOffsetPixels = safeAreaTop * scaleFactor;
    
                // The Screen Layout tree was previously appended here but produced huge noisy
                // output (nested Svg/G/Path duplicates). Agents should use get_screen_layout
                // explicitly when they need the tree. The Pressable elements block below is
                // the signal most consumers actually want.
                let pressablesText: string | null = null;
                let pressablesIsScreenState = false;

                // Enrich with the screen-state summary (route + overlay-grouped pressables —
                // same engine as get_screen_state, so blocked pressables behind sheets are
                // excluded). Requires a connected RN app; otherwise fall back to the flat
                // pressables list (which degrades further to the iOS accessibility tree).
                if (targetApp) {
                    try {
                        const ssResult = await getScreenState({ device: targetDeviceName });
                        if (ssResult.success && ssResult.screenState) {
                            const screenshotScale = result.scaleFactor || 1;
                            const toPx = (v: number) => Math.round((v * scaleFactor) / screenshotScale);
                            pressablesText = formatScreenStateSummary(ssResult.screenState, (p) => {
                                // See enrichScreenshotWithLayout: shift y when fiber reports the
                                // element inside the safe-area band (react-native-screens modals).
                                const yShift = safeAreaTop > 0 && p.center.y < safeAreaTop ? safeAreaTop : 0;
                                return {
                                    center: { x: toPx(p.center.x), y: toPx(p.center.y + yShift) },
                                    frame: {
                                        x: toPx(p.bounds.x),
                                        y: toPx(p.bounds.y + yShift),
                                        width: toPx(p.bounds.width),
                                        height: toPx(p.bounds.height),
                                    },
                                };
                            });
                            pressablesIsScreenState = true;
                        }
                    } catch {
                        // Non-fatal: fall through to the flat pressables list below
                    }
                }
                if (!pressablesText) {
                    try {
                        const pressables = await getPressableElements({
                            device: targetDeviceName,
                            platform: "ios",
                            udid: resolvedUdid ?? undefined
                        });
                        if (pressables.success && pressables.parsedElements && pressables.parsedElements.length > 0) {
                            const screenshotScale = result.scaleFactor || 1;
                            pressablesText = pressables.parsedElements.map((el) => {
                                // See enrichScreenshotWithLayout: shift y when fiber reports the element
                                // inside the safe-area band (a react-native-screens modal artifact).
                                let centerYPoints = el.center.y;
                                if (safeAreaTop > 0 && centerYPoints < safeAreaTop) {
                                    centerYPoints += safeAreaTop;
                                }
                                const px = Math.round((el.center.x * scaleFactor) / screenshotScale);
                                const py = Math.round((centerYPoints * scaleFactor) / screenshotScale);
                                const label = el.accessibilityLabel || el.text || el.testID || iconLabel(el.component, el.icon) || (el.intent ? `${el.intent} icon` : el.component);
                                const idPart = el.testID ? ` testID="${el.testID}"` : "";
                                const kindPart = el.isInput ? " [input]" : "";
                                const wrapPart = el.isWrapper ? " [wrapper — skip]" : "";
                                const nearPart = !el.text && !el.accessibilityLabel && el.nearbyText ? ` near "${el.nearbyText}"` : "";
                                return `  (${px}, ${py}) ${el.component}: "${label}"${nearPart}${idPart}${kindPart}${wrapPart}`;
                            }).join("\n");
                        }
                    } catch {
                        // Non-fatal: screenshot works without pressables enrichment
                    }
                }
    
                const deliveredWidth = result.scaleFactor && result.scaleFactor > 1
                    ? Math.round(pixelWidth / result.scaleFactor)
                    : pixelWidth;
                const deliveredHeight = result.scaleFactor && result.scaleFactor > 1
                    ? Math.round(pixelHeight / result.scaleFactor)
                    : pixelHeight;
                let infoText: string;
                if (result.scaleFactor && result.scaleFactor > 1) {
                    infoText = `Screenshot: raw ${pixelWidth}x${pixelHeight} px → delivered ${deliveredWidth}x${deliveredHeight} px (downscaled ${(1 / result.scaleFactor).toFixed(3)}× to fit API limits). Pressable coordinates below are in delivered-image pixels.`;
                } else {
                    infoText = `Screenshot captured (${pixelWidth}x${pixelHeight} pixels)`;
                }
                // Echo the simulator actually captured so a wrong-device grab is
                // detectable at a glance (esp. with multiple sims booted).
                if (targetUdid) {
                    infoText += `\n📸 Captured from: ${targetDeviceName ? `${targetDeviceName} ` : ""}(${targetUdid})`;
                }
                infoText += `\n📱 iOS screen: ${pointWidth}x${pointHeight} points (${scaleFactor}x scale)`;
                infoText += `\n📐 tap() handles pixel-to-point conversion automatically — pass pixel coords from this image directly`;
                infoText += `\n⚠️ Status bar + safe area: ${safeAreaTop} points (${safeAreaOffsetPixels} pixels) from top`;
                if (pressablesText) {
                    infoText += pressablesIsScreenState
                        ? `\n\n🧭 Screen state (route + tappable elements, coordinates in screenshot pixels):\n`
                        : `\n\n🎯 Pressable elements (ready-to-tap, coordinates in screenshot pixels):`;
                    infoText += `\n${pressablesText}`;
                    infoText += `\n\n💡 Next steps:`;
                    infoText += `\n  • tap(text="Button Label") — when text is exact and unique`;
                    infoText += `\n  • tap(testID="id") or tap(component="Name") — when you know the identifier`;
                    infoText += `\n  • tap(x=<px>, y=<px>) — use coordinates from the pressable elements list above (reliable for icons and ambiguous elements)`;
                    infoText += `\n  • get_screen_layout — full component tree when you need more than pressables`;
                } else {
                    if (!targetApp && connectedApps.size > 0) {
                        infoText += `\n\nℹ️ Pressable enrichment skipped: no RN app is connected to simulator ${resolvedUdid}.`;
                        infoText += ` ${connectedApps.size} other app(s) are connected on different device(s) — their fiber data was intentionally not used to avoid mismatched output.`;
                    }
                    infoText += `\n\n💡 Next steps:`;
                    infoText += `\n  • tap(text="Button Label") — tap element by visible text`;
                    infoText += `\n  • tap(x=<px>, y=<px>) — tap at coordinates from this screenshot`;
                    infoText += `\n  • get_screen_layout — get full UI tree with real on-screen positions`;
                }
    
                // Check for LogBox overlay — only on the matching RN app; skip otherwise
                // to avoid surfacing warnings from a different simulator's app.
                if (targetApp) {
                    try {
                        const logBoxState = await detectLogBox(targetDeviceName);
                        if (logBoxState && logBoxState.total > 0) {
                            infoText += formatLogBoxWarning(logBoxState);
                        }
                    } catch {
                        // Non-fatal: LogBox detection failure should not break screenshot
                    }
                }
    
                // I1 (2026-05-16): detect native iOS system overlays (auth sheets, alerts,
                // permission dialogs) that sit on top of the RN app. The pressables list
                // reflects the RN screen underneath; without this warning the agent will
                // happily tap inert RN buttons and loop. Runs whether or not there's a
                // matching RN app — the overlay belongs to the simulator, not the app.
                try {
                    const overlay = await detectIOSSystemOverlay(resolvedUdid ?? undefined);
                    if (overlay) {
                        infoText += formatIOSSystemOverlayWarning(overlay);
                    }
                } catch {
                    // Non-fatal: overlay detection failure should not break screenshot
                }
    
                imageBuffer.add({
                    id: `ios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    image: result.data,
                    timestamp: Date.now(),
                    source: "ios_screenshot",
                    metadata: {
                        width: result.originalWidth || 0,
                        height: result.originalHeight || 0,
                        scaleFactor: result.scaleFactor || 1,
                        platform: "ios",
                    },
                });
    
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: infoText
                        },
                        {
                            type: "image" as const,
                            data: result.data.toString("base64"),
                            mimeType: "image/jpeg"
                        }
                    ]
                };
            }
    
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Screenshot saved to: ${result.result}`
                    }
                ]
            };
        }
    );
    // Tool: Android screenshot
    registerToolWithTelemetry(
        server,
        "android_screenshot",
        {
            description: "Take a screenshot from an Android device/emulator. Returns the image plus a screen-state summary: active route (name + navigation stack), overlay-grouped tappable elements (pressables behind an open sheet/modal are excluded), component names as JSX tags, labels, testIDs, and frames — all in ready-to-tap pixel coordinates. Prefer tap(text=\"...\") when text is exact and unique; otherwise use tap(x, y) with coordinates from the list — this is the most reliable way to tap icons or visually-identified elements. Use component names for inspect_component/find_components.\n" +
                "PURPOSE: Snapshot what the user sees on Android AND get tap-ready pressables + a structured component map in one call.\n" +
                "WHEN TO USE: Any visual verification, before/after comparison, or as the starting point for tapping UI by coordinates on Android.\n" +
                "WORKFLOW: android_screenshot -> pick element from pressables -> tap(x, y) or tap(testID=...) -> android_screenshot to verify.\n" +
                "LIMITATIONS: Requires adb in PATH and a running device/emulator. For non-RN surfaces (system dialogs, permission prompts), combine with tap(..., native=true).\n" +
                "GOOD: android_screenshot()\n" +
                "BAD: android_screenshot({ deviceId: \"guess\" }) with a made-up serial — run list_android_devices first.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
            inputSchema: {
                outputPath: z
                    .string()
                    .optional()
                    .describe("Optional path to save the screenshot. If not provided, saves to temp directory."),
                deviceId: z
                    .string()
                    .optional()
                    .describe(
                        "Optional Android target. Accepts an adb serial (e.g. 'emulator-5554', 'RFCX20CLX3F'), an emulator name, or a substring of the connected RN device name (e.g. 'sdk_gphone'). Uses first available device if not specified."
                    )
            }
        },
        async ({ outputPath, deviceId }) => {
            const resolved = await resolveAndroidDeviceId(deviceId);
            if (!resolved.ok) return resolved.response;
            const result = await androidScreenshot(outputPath, resolved.serial);
    
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: ${result.error}`
                        }
                    ],
                    isError: true
                };
            }
    
            // Include image data if available
            if (result.data) {
                // Build info text with coordinate conversion guidance
                const pixelWidth = result.originalWidth || 0;
                const pixelHeight = result.originalHeight || 0;
    
                // Resolve the RN app running on THIS Android device so enrichment
                // pulls data from the right app (not whichever app is "first").
                const targetApp = getConnectedAppByAndroidDeviceId(deviceId);
                const targetDeviceName = targetApp?.deviceInfo.deviceName;
    
                // Store screenshot metadata on the matching app (not an arbitrary one)
                if (targetApp) {
                    targetApp.lastScreenshot = {
                        originalWidth: pixelWidth,
                        originalHeight: pixelHeight,
                        scaleFactor: result.scaleFactor || 1,
                    };
                }
    
                const androidDeliveredW = result.scaleFactor && result.scaleFactor > 1
                    ? Math.round(pixelWidth / result.scaleFactor)
                    : pixelWidth;
                const androidDeliveredH = result.scaleFactor && result.scaleFactor > 1
                    ? Math.round(pixelHeight / result.scaleFactor)
                    : pixelHeight;
                let infoText = result.scaleFactor && result.scaleFactor > 1
                    ? `Screenshot: raw ${pixelWidth}x${pixelHeight} px → delivered ${androidDeliveredW}x${androidDeliveredH} px (downscaled ${(1 / result.scaleFactor).toFixed(3)}× to fit API limits). Pressable coordinates below are in delivered-image pixels.`
                    : `Screenshot captured (${pixelWidth}x${pixelHeight} pixels)`;
    
                // Get status bar height for coordinate guidance
                let statusBarPixels = 63; // Default fallback
                let statusBarDp = 24;
                let densityDpi = 440; // Common default
                try {
                    const statusBarResult = await androidGetStatusBarHeight(deviceId);
                    if (statusBarResult.success && statusBarResult.heightPixels) {
                        statusBarPixels = statusBarResult.heightPixels;
                        statusBarDp = statusBarResult.heightDp || 24;
                    }
                    const densityResult = await androidGetDensity(deviceId);
                    if (densityResult.success && densityResult.density) {
                        densityDpi = densityResult.density;
                    }
                } catch {
                    // Use defaults
                }
    
                // Enrich with screen layout data (component names + tap coordinates).
                // On Bridgeless/Fabric Android (the only target architecture we support;
                // legacy arch is <5% of users and not a priority), both code paths that
                // feed this enrichment return DEVICE PIXELS:
                //   - fiber path: React's measureInWindow on Fabric returns native pixels.
                //   - a11y fallback: uiautomator's bounds are already device pixels.
                // The earlier formula multiplied by densityDpi/160 on the (incorrect)
                // assumption that fiber returned DP — inflating every coordinate by
                // ~2.6× on a 420dpi emulator and producing numbers like (1170, 4054)
                // for a button visually sitting near (445, 1370) in the JPEG. Drop the
                // density factor; only the scaleFactor downscale is needed.
                let pressablesText: string | null = null;
                let pressablesIsScreenState = false;
                // Screen Layout tree previously appended here was dropped — it was noisy
                // (nested Svg/G/Path duplicates). Use get_screen_layout when the tree is needed.

                // Prefer the screen-state summary (route + overlay-grouped pressables).
                // Coordinates are fiber dp scaled by density + status-bar offset — the same
                // best-effort conversion as the pressables fallback path (see pressables.ts);
                // tap(text=)/tap(testID=) remain the precise options.
                if (targetApp) {
                    try {
                        const ssResult = await getScreenState({ device: targetDeviceName });
                        if (ssResult.success && ssResult.screenState) {
                            const screenshotScale = result.scaleFactor || 1;
                            const densityScale = densityDpi / 160;
                            const toPx = (v: number) => Math.round((v * densityScale) / screenshotScale);
                            const toPxY = (v: number) => Math.round((v * densityScale + statusBarPixels) / screenshotScale);
                            pressablesText = formatScreenStateSummary(ssResult.screenState, (p) => ({
                                center: { x: toPx(p.center.x), y: toPxY(p.center.y) },
                                frame: {
                                    x: toPx(p.bounds.x),
                                    y: toPxY(p.bounds.y),
                                    width: toPx(p.bounds.width),
                                    height: toPx(p.bounds.height),
                                },
                            }));
                            pressablesIsScreenState = true;
                        }
                    } catch {
                        // Non-fatal: fall through to the flat pressables list below
                    }
                }

                // Fallback: flat pressable elements. With targetApp present this uses the
                // fiber path (uiautomator-reconciled coords). Without targetApp it degrades
                // to the Android accessibility (uiautomator) tree (E1).
                try {
                    const pressables = pressablesText ? null : await getPressableElements({ device: targetDeviceName, platform: "android" });
                    if (pressables && pressables.success && pressables.parsedElements && pressables.parsedElements.length > 0) {
                        const screenshotScale = result.scaleFactor || 1;
                        pressablesText = pressables.parsedElements.map((el) => {
                            const px = Math.round(el.center.x / screenshotScale);
                            const py = Math.round(el.center.y / screenshotScale);
                            const label = el.accessibilityLabel || el.text || el.testID || iconLabel(el.component, el.icon) || (el.intent ? `${el.intent} icon` : el.component);
                            const idPart = el.testID ? ` testID="${el.testID}"` : "";
                            const kindPart = el.isInput ? " [input]" : "";
                            const wrapPart = el.isWrapper ? " [wrapper — skip]" : "";
                            const nearPart = !el.text && !el.accessibilityLabel && el.nearbyText ? ` near "${el.nearbyText}"` : "";
                            return `  (${px}, ${py}) ${el.component}: "${label}"${nearPart}${idPart}${kindPart}${wrapPart}`;
                        }).join("\n");
                    }
                } catch {
                    // Non-fatal: screenshot works without pressables enrichment
                }
    
                infoText += `\n📱 Android uses PIXELS for all coordinates`;
    
                if (result.scaleFactor && result.scaleFactor > 1) {
                    infoText += `\n📐 tap() handles coordinate conversion automatically — pass pixel coords from this image directly`;
                } else {
                    infoText += `\n📐 Screenshot coords = tap coords (no conversion needed)`;
                }
    
                infoText += `\n⚠️ Status bar: ${statusBarPixels}px (${statusBarDp}dp) from top - app content starts below this`;
                infoText += `\n📊 Display density: ${densityDpi}dpi`;
                if (pressablesText) {
                    infoText += pressablesIsScreenState
                        ? `\n\n🧭 Screen state (route + tappable elements, coordinates in screenshot pixels):\n`
                        : `\n\n🎯 Pressable elements (ready-to-tap, coordinates in screenshot pixels):`;
                    infoText += `\n${pressablesText}`;
                    infoText += `\n\n💡 Next steps:`;
                    infoText += `\n  • tap(text="Button Label") — when text is exact and unique`;
                    infoText += `\n  • tap(testID="id") or tap(component="Name") — when you know the identifier`;
                    infoText += `\n  • tap(x=<px>, y=<px>) — use coordinates from the pressable elements list above (reliable for icons and ambiguous elements)`;
                    infoText += `\n  • get_screen_layout — full component tree when you need more than pressables`;
                } else {
                    if (!targetApp && connectedApps.size > 0) {
                        infoText += `\n\nℹ️ Pressable enrichment skipped: no RN app is connected to device ${deviceId ?? "(default)"}.`;
                        infoText += ` ${connectedApps.size} other app(s) are connected on different device(s) — their fiber data was intentionally not used to avoid mismatched output.`;
                    }
                    infoText += `\n\n💡 Next steps:`;
                    infoText += `\n  • tap(text="Button Label") — tap element by visible text`;
                    infoText += `\n  • tap(x=<px>, y=<px>) — tap at coordinates from this screenshot`;
                    infoText += `\n  • get_screen_layout — get full UI tree with real on-screen positions`;
                }
    
                // Check for LogBox overlay — only on the matching RN app; skip otherwise
                // to avoid surfacing warnings from a different device's app.
                if (targetApp) {
                    try {
                        const logBoxState = await detectLogBox(targetDeviceName);
                        if (logBoxState && logBoxState.total > 0) {
                            infoText += formatLogBoxWarning(logBoxState);
                        }
                    } catch {
                        // Non-fatal: LogBox detection failure should not break screenshot
                    }
                }
    
                imageBuffer.add({
                    id: `android-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    image: result.data,
                    timestamp: Date.now(),
                    source: "android_screenshot",
                    metadata: {
                        width: result.originalWidth || 0,
                        height: result.originalHeight || 0,
                        scaleFactor: result.scaleFactor || 1,
                        platform: "android",
                    },
                });
    
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: infoText
                        },
                        {
                            type: "image" as const,
                            data: result.data.toString("base64"),
                            mimeType: "image/jpeg"
                        }
                    ]
                };
            }
    
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Screenshot saved to: ${result.result}`
                    }
                ]
            };
        }
    );
    // Tool: Get images from shared image buffer
    registerToolWithTelemetry(
        server,
        "get_images",
        {
            description:
                "Access the shared image buffer containing screenshots from all tools (ios_screenshot, android_screenshot, ocr_screenshot, tap verification). Returns metadata only by default — use id or groupId+frameIndex to retrieve actual image data. Tap burst verification stores frame groups here when burst=true is used.\n" +
                "PURPOSE: Retrieve prior screenshots — especially tap burst frames — without re-taking them, for visual diffing or reviewing transient UI states.\n" +
                "WHEN TO USE: After tap(burst=true) reports transientChangeDetected, or to compare before/after frames without another screenshot round-trip.\n" +
                "WORKFLOW: tap(burst=true) -> note verification.burstGroupId -> get_images(groupId, frameIndex=N) to inspect individual frames.\n" +
                "LIMITATIONS: Circular buffer (50 entries) — old images are evicted. Metadata is cheap; fetching image data is not — request specific ids, not bulk.\n" +
                "GOOD: get_images({ list: true }); get_images({ groupId: \"burst-abc\", frameIndex: 2 })\n" +
                "BAD: get_images() with no filter when buffer is full — floods context. Use list:true or last:N first.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full interaction playbook.",
            inputSchema: {
                list: z.boolean().optional().describe("List all entries and groups (metadata only, no image data)"),
                id: z.string().optional().describe("Retrieve a specific image by ID (returns image data)"),
                groupId: z.string().optional().describe("List frames in a group (metadata only), or combine with frameIndex to retrieve a specific frame"),
                frameIndex: z.coerce.number().optional().describe("Retrieve a specific frame from a group (requires groupId)"),
                last: z.coerce.number().optional().describe("Return the N most recent entries (metadata only)"),
                source: z.string().optional().describe("Filter entries by source"),
                clear: z.boolean().optional().describe("Clear the buffer")
            }
        },
        async ({ id, groupId, frameIndex, last, source, clear }) => {
            if (clear) {
                const count = imageBuffer.clear();
                return {
                    content: [{ type: "text" as const, text: `Cleared ${count} images from buffer.` }]
                };
            }
    
            if (id) {
                const entry = imageBuffer.getById(id);
                if (!entry) {
                    return {
                        content: [{ type: "text" as const, text: `No image found with id "${id}".` }],
                        isError: true
                    };
                }
                const { image, ...meta } = entry;
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify(meta, null, 2) },
                        { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
                    ]
                };
            }
    
            if (groupId !== undefined && frameIndex !== undefined) {
                const entry = imageBuffer.getByGroupFrame(groupId, frameIndex);
                if (!entry) {
                    return {
                        content: [{ type: "text" as const, text: `No frame ${frameIndex} found in group "${groupId}".` }],
                        isError: true
                    };
                }
                const { image, ...meta } = entry;
                return {
                    content: [
                        { type: "text" as const, text: JSON.stringify(meta, null, 2) },
                        { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }
                    ]
                };
            }
    
            const entries = imageBuffer.listEntries({ source, groupId, last });
            const groups = imageBuffer.listGroups();
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({ entries, groups, total: imageBuffer.size }, null, 2)
                    }
                ]
            };
        }
    );
    // Tool: OCR Screenshot - Extract text with coordinates from screenshot
    registerToolWithTelemetry(
        server,
        "ocr_screenshot",
        {
            description:
                "RECOMMENDED: Use this tool FIRST when you need to find and tap UI elements. Takes a screenshot and extracts all visible text with tap-ready coordinates using OCR. " +
                "ADVANTAGES over accessibility trees: (1) Works on ANY visible text regardless of accessibility labels, (2) Returns ready-to-use tapX/tapY coordinates - no conversion needed, (3) Faster than parsing accessibility hierarchies, (4) Works consistently across iOS and Android. " +
                "USE THIS FOR: Finding buttons, labels, menu items, tab bars, or any text you need to tap. Simply find the text in the results and use its tapX/tapY with the tap command.\n" +
                "PURPOSE: Visually locate text on screen and return coordinates safe to pass straight into tap.\n" +
                "WHEN TO USE: Non-RN surfaces, third-party WebViews, accessibility-poor screens, or when fiber/testID strategies have failed.\n" +
                "WORKFLOW: ocr_screenshot(platform=\"ios\") -> scan results for the label -> tap(x=tapX, y=tapY) -> ios_screenshot to verify.\n" +
                "LIMITATIONS: OCR accuracy degrades on very small or stylized text; icons with no label won't appear — use tap(component=...) instead.\n" +
                "GOOD: ocr_screenshot({ platform: \"ios\" })\n" +
                "BAD: ocr_screenshot used just to view the screen — plain ios_screenshot / android_screenshot is cheaper when you don't need OCR text.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full device-interaction playbook.",
            inputSchema: {
                platform: z.enum(["ios", "android"]).describe("Platform to capture screenshot from"),
                deviceId: z
                    .string()
                    .optional()
                    .describe("Optional device ID (Android) or UDID (iOS). Uses first available device if not specified.")
            }
        },
        async ({ platform, deviceId }) => {
            try {
                let screenshotResult;
                if (platform === "android") {
                    const r = await resolveAndroidDeviceId(deviceId);
                    if (!r.ok) return r.response;
                    screenshotResult = await androidScreenshot(undefined, r.serial);
                } else {
                    const r = await resolveIosUdid(deviceId);
                    if (!r.ok) return r.response;
                    screenshotResult = await iosScreenshot(undefined, r.udid);
                }
    
                if (!screenshotResult.success || !screenshotResult.data) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `Screenshot failed: ${screenshotResult.error || "No image data"}`
                            }
                        ],
                        isError: true
                    };
                }
    
                // Calculate device pixel ratio for iOS
                const devicePixelRatio =
                    platform === "ios" && screenshotResult.originalWidth && screenshotResult.originalHeight
                        ? inferIOSDevicePixelRatio(screenshotResult.originalWidth, screenshotResult.originalHeight)
                        : 1;
    
                // Run OCR on the screenshot
                const scaleFactor = screenshotResult.scaleFactor || 1;
                const ocrResult = await recognizeText(screenshotResult.data, {
                    scaleFactor,
                    platform,
                    devicePixelRatio
                });
    
                if (!ocrResult.success) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `OCR failed: no text recognized`
                            }
                        ],
                        isError: true
                    };
                }
    
                // Format results for MCP tool output
                const elements = ocrResult.words
                    .filter((w: { confidence: number; text: string }) => w.confidence > 50 && w.text.trim().length > 0)
                    .map((w: { text: string; confidence: number; tapCenter: { x: number; y: number } }) => ({
                        text: w.text,
                        confidence: Math.round(w.confidence),
                        tapX: w.tapCenter.x,
                        tapY: w.tapCenter.y
                    }));
    
                const result: Record<string, unknown> = {
                    platform,
                    engine: ocrResult.engine || "unknown",
                    processingTimeMs: ocrResult.processingTimeMs,
                    fullText: ocrResult.fullText?.trim() || "",
                    confidence: Math.round(ocrResult.confidence || 0),
                    elementCount: elements.length,
                    elements,
                    note: "tapX/tapY are in device pixels — pass directly to tap(x, y) for automatic platform conversion"
                };
    
                // Check for LogBox overlay (uses default CDP device — native deviceId cannot be mapped to CDP device name)
                try {
                    const logBoxState = await detectLogBox();
                    if (logBoxState && logBoxState.total > 0) {
                        result.logBoxWarning = formatLogBoxWarning(logBoxState).trim();
                    }
                } catch {
                    // Non-fatal: LogBox detection failure should not break OCR
                }
    
                // Store screenshot in image buffer
                try {
                    imageBuffer.add({
                        id: `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        image: screenshotResult.data,
                        timestamp: Date.now(),
                        source: "ocr_screenshot",
                        metadata: {
                            width: screenshotResult.originalWidth || 0,
                            height: screenshotResult.originalHeight || 0,
                            scaleFactor,
                            platform,
                        },
                    });
                } catch {
                    // Non-fatal: image buffer write failure should not break OCR response
                }
    
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: JSON.stringify(result, null, 2)
                        }
                    ]
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `OCR failed: ${error instanceof Error ? error.message : String(error)}`
                        }
                    ],
                    isError: true
                };
            }
        }
    );
}
