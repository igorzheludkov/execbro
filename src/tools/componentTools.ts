import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { iconLabel } from "../core/iconSemantics.js";
import {
    getComponentTree,
    getScreenLayout,
    formatScreenLayoutTree,
    getPressableElements,
    getScreenState,
    formatScreenStateSummary,
    inspectComponent,
    findComponents,
    toggleElementInspector,
    getInspectorSelection,
    getInspectorSelectionAtPoint,
    inspectAtPoint,
    measureComponent,
    iosScreenshot,
    androidScreenshot,
    androidGetDensity,
    getDevicePixelRatio,
    getIOSSafeAreaTop,
    inferIOSDevicePixelRatio,
    metroMissingHintIfAbsent,
    hasMetro,
    getConnectedAppByDevice,
    getFirstConnectedApp,
    connectedApps,
} from "../core/index.js";
import { primaryInteractionBanner } from "../core/toolHelpers.js";
import type { ExecutionResult } from "../core/types.js";

function collectMetaNotes(r: ExecutionResult): string[] {
    const out: string[] = [];
    if (r._meta?.reconnected) {
        out.push(`[reconnected: transport error "${r._meta.transportError ?? "unknown"}" was auto-recovered]`);
    }
    if (r._meta?.timeoutClampedFrom !== undefined) {
        out.push(`[warning: timeoutMs ${r._meta.timeoutClampedFrom} clamped to 120000]`);
    }
    return out;
}

export function registerComponentTools(server: McpServer): void {
    // Tool: Get full screen layout (all components with layout styles)
    registerToolWithTelemetry(
        server,
        "get_screen_layout",
        {
            description:
                "Get a screen map showing visible components as an indented tree with actual screen positions. Uses measureInWindow for real coordinates and filters out off-screen components. Returns meaningful component names with text content and frame data (x,y width x height). Coordinates are in **points** (iOS) or **dp** (Android) — NOT screenshot pixels. Use tap(text=...) or tap(testID=...) to interact with discovered components. Use extended=true to include layout styles (padding, margin, flex, backgroundColor, etc.)." +
                primaryInteractionBanner() + "\n" +
                "PURPOSE: Quickest textual map of what is actually on screen right now — component names, positions, and text — so you can plan taps and inspections without guessing.\n" +
                "WHEN TO USE: First step whenever the user asks \"what's on screen\", \"why is X covering Y\", or before tapping a visually ambiguous element.\n" +
                "WORKFLOW: get_screen_layout -> find_components(pattern=\"...\") or inspect_component(componentName=\"...\") -> tap(testID=...) -> get_screen_layout again to confirm.\n" +
                "LIMITATIONS: Coordinates are points/dp, not screenshot pixels — pass them to tap() which handles conversion, do not multiply by devicePixelRatio yourself.\n" +
                "GOOD: get_screen_layout({ extended: true })\n" +
                "BAD: get_screen_layout({ summary: true }) when you actually need to pick a specific element — summary hides the tree.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"layout\") for the full layout-check playbook.",
            inputSchema: {
                extended: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include layout styles (padding, margin, flex, backgroundColor, borderRadius, etc.) for each component. Default: false for compact output."),
                summary: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Return only component counts by name instead of full tree (default: false)"),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices."),
                timeoutMs: z.coerce
                    .number()
                    .optional()
                    .describe(
                        "Per-call timeout in milliseconds. Default: 5000; bumped to 15000 when extended=true. Hard cap: 120000."
                    )
            }
        },
        async ({ extended, summary, device, timeoutMs }) => {
            if (!hasMetro()) {
                const hint = await metroMissingHintIfAbsent("get_screen_layout");
                return {
                    content: [{ type: "text", text: `Screen Layout unavailable.${hint}` }],
                    isError: true
                };
            }

            const effectiveTimeoutMs = timeoutMs ?? (extended ? 15000 : 5000);
            const result = await getScreenLayout({ extended, summary, device, timeoutMs: effectiveTimeoutMs });

            const metaNotes = collectMetaNotes(result);

            if (!result.success) {
                const errText = metaNotes.length > 0 ? `Error: ${result.error}\n\n${metaNotes.join("\n")}` : `Error: ${result.error}`;
                return {
                    content: [{ type: "text", text: errText }],
                    isError: true
                };
            }

            const body = metaNotes.length > 0
                ? `Screen Layout:\n\n${result.result}\n\n${metaNotes.join("\n")}`
                : `Screen Layout:\n\n${result.result}`;
            return { content: [{ type: "text", text: body }] };
        }
    );
    
    
    
    
    
    
    
    // ============================================================================
    // React Component Inspection Tools
    // ============================================================================
    
    // Tool: Get the React component tree
    registerToolWithTelemetry(
        server,
        "get_component_tree",
        {
            description:
                "Get the full React component tree from the running app. Shows the complete fiber hierarchy including providers, navigation wrappers, and internal components. For a screen overview with positions and text, use get_screen_layout instead. Use structureOnly=true for compact names-only output.\n" +
                "PURPOSE: Expose the entire fiber tree — including providers, navigators, and off-screen subtrees — when get_screen_layout's visible-only view isn't enough.\n" +
                "WHEN TO USE: Debugging context propagation, navigation wrappers, hidden modals, or when you need to understand the full React architecture.\n" +
                "WORKFLOW: get_component_tree(structureOnly=true) for overview -> find_components for targeted lookup -> inspect_component for props/state.\n" +
                "LIMITATIONS: Full trees can be large; always start with structureOnly=true. Ignores non-React native views. Minified builds return display names that may be opaque.\n" +
                "GOOD: get_component_tree({ structureOnly: true })\n" +
                "BAD: get_component_tree({ includeProps: true, includeStyles: true }) on a large app — likely hits response-size limits. Prefer inspect_component for specific nodes.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
            inputSchema: {
                structureOnly: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Return ultra-compact structure with just component names (no props, styles, or paths). Use this first for overview, then drill down with inspect_component."
                    ),
                maxDepth: z
                    .number()
                    .optional()
                    .describe(
                        "Maximum tree depth (default: 5000)"
                    ),
                includeProps: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include component props (excluding children and style). Ignored if structureOnly=true."),
                includeStyles: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include layout styles (padding, margin, flex, etc.). Ignored if structureOnly=true."),
                hideInternals: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "Hide internal RN components (RCTView, RNS*, Animated, etc.) for cleaner output (default: true)"
                    ),
                format: z
                    .enum(["json", "tonl"])
                    .optional()
                    .default("tonl")
                    .describe(
                        "Output format: 'json' or 'tonl' (default, compact indented tree). Ignored if structureOnly=true."
                    ),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices."),
                timeoutMs: z.coerce
                    .number()
                    .optional()
                    .describe("Per-call timeout in milliseconds. Default: 5000. Hard cap: 120000.")
            }
        },
        async ({ structureOnly, maxDepth, includeProps, includeStyles, hideInternals, format, device, timeoutMs }) => {
            const effectiveTimeoutMs = timeoutMs ?? 5000;
            const result = await getComponentTree({
                structureOnly,
                maxDepth,
                includeProps,
                includeStyles,
                hideInternals,
                format,
                device,
                timeoutMs: effectiveTimeoutMs
            });

            const metaNotes = collectMetaNotes(result);

            if (!result.success) {
                const errText = metaNotes.length > 0 ? `Error: ${result.error}\n\n${metaNotes.join("\n")}` : `Error: ${result.error}`;
                return {
                    content: [{ type: "text", text: errText }],
                    isError: true
                };
            }

            const body = metaNotes.length > 0
                ? `React Component Tree:\n\n${result.result}\n\n${metaNotes.join("\n")}`
                : `React Component Tree:\n\n${result.result}`;
            return { content: [{ type: "text", text: body }] };
        }
    );
    
    // Tool: Get all pressable elements on screen
    registerToolWithTelemetry(
        server,
        "get_pressable_elements",
        {
            description:
                "Prefer get_screen_state after navigation (route + overlays + pressables in one call).\n\n" +
                "Find all pressable (onPress) and input (TextInput) elements currently visible on screen. Returns component names, ready-to-tap center coordinates in SCREENSHOT PIXELS (same space as ios_screenshot/android_screenshot — pass directly to tap(x, y)), text labels, testID, accessibilityLabel, and a spatial nearbyText hint for icon-only buttons. Each element includes hasLabel (true if it contains text) and isInput (true for TextInput fields).\n" +
                "HELPER — call before `tap` when you need to enumerate candidate elements before committing to a target; not a replacement for tap itself.\n" +
                "PURPOSE: Produce a ready-to-tap inventory of every interactive element on screen with screenshot-pixel coordinates that tap(x, y) accepts directly.\n" +
                "WHEN TO USE: Before tapping icon-only buttons, when text-based tap keeps failing, or to enumerate what the user can actually interact with.\n" +
                "WORKFLOW: ios_screenshot / android_screenshot -> get_pressable_elements -> tap(testID=\"...\") or tap(x, y) using the center coordinates.\n" +
                "LIMITATIONS: Visible-only (off-screen pressables are excluded). Requires a live React connection. Coordinates are in screenshot pixels — the tap tool converts to points internally.\n" +
                "GOOD: get_pressable_elements()\n" +
                "BAD: Calling when tap(testID=\"...\") already works — testID matching is faster and more stable.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"interact\") for the full interaction playbook.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ device }) => {
            const result = await getPressableElements({ device });
    
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error}`
                        }
                    ],
                    isError: true
                };
            }
    
            const elements = result.parsedElements;
            if (!elements || elements.length === 0) {
                return {
                    content: [{ type: "text", text: result.result || "No pressable elements found." }]
                };
            }
    
            // Resolve target app so we can pick the right simulator / android device
            const targetApp = device ? getConnectedAppByDevice(device) : getFirstConnectedApp();
            if (!targetApp) {
                // No connected app — return raw (points) output; better than nothing
                return {
                    content: [{ type: "text", text: result.result || "No pressable elements found." }]
                };
            }
    
            // Capture a lightweight screenshot to learn scaleFactor (downscale) and dimensions.
            // Conversion: screenshot_px = native_coord * devicePixelRatio / screenshotScale
            let lines: string[] = [];
            try {
                if (targetApp.platform === "ios") {
                    const udid = targetApp.simulatorUdid;
                    const shot = await iosScreenshot(undefined, udid);
                    const screenshotScale = shot.scaleFactor || 1;
                    const devicePixelRatio =
                        (shot.originalWidth && shot.originalHeight
                            ? inferIOSDevicePixelRatio(shot.originalWidth, shot.originalHeight)
                            : null) ?? (await getDevicePixelRatio(udid)) ?? 3;
                    // Fallback to 59pt (iPhone typical) when the UI driver preflight can't
                    // resolve the true inset — matches ios_screenshot's default. Without this
                    // shift, react-native-screens modal-presented screens report y relative
                    // to content origin and taps land in the status bar instead of the button.
                    const safeAreaTop = (await getIOSSafeAreaTop(udid).catch(() => 0)) || 59;
                    // Keep the app's lastScreenshot metadata in sync so tap(x, y) uses the
                    // same scaleFactor when converting our pixel coords back to points.
                    if (shot.originalWidth && shot.originalHeight) {
                        targetApp.lastScreenshot = {
                            originalWidth: shot.originalWidth,
                            originalHeight: shot.originalHeight,
                            scaleFactor: screenshotScale
                        };
                    }
                    lines = formatPressablesInPixels(elements, {
                        platform: "ios",
                        devicePixelRatio,
                        screenshotScale,
                        safeAreaTop
                    });
                } else {
                    // Metro's `deviceName` is the device model (e.g. "sdk_gphone16k_arm64"),
                    // not the adb serial (e.g. "emulator-5554"), so passing it as -s makes
                    // adb miss the device and androidScreenshot/androidGetDensity silently
                    // return defaults (scale=1, density=160). That leaves coords in raw
                    // device pixels — off by ~1.2× from the screenshot/JPEG space the tool
                    // description promises. Pass undefined to let adb auto-pick (matches
                    // how android_screenshot works when called without deviceId). Multi-
                    // Android-device support tracks separately under the multi-device
                    // refactor; this path is a single-Android-device fix.
                    const shot = await androidScreenshot(undefined, undefined);
                    const screenshotScale = shot.scaleFactor || 1;
                    const density = await androidGetDensity(undefined).catch(() => ({ density: 160 }));
                    const devicePixelRatio = (density.density || 160) / 160;
                    if (shot.originalWidth && shot.originalHeight) {
                        targetApp.lastScreenshot = {
                            originalWidth: shot.originalWidth,
                            originalHeight: shot.originalHeight,
                            scaleFactor: screenshotScale
                        };
                    }
                    lines = formatPressablesInPixels(elements, {
                        platform: "android",
                        devicePixelRatio,
                        screenshotScale,
                        safeAreaTop: 0
                    });
                }
            } catch {
                // Fallback to points if screenshot/metadata unavailable
                return {
                    content: [{ type: "text", text: result.result || "No pressable elements found." }]
                };
            }
    
            const iconCount = elements.filter((e) => !e.hasLabel).length;
            const labeledCount = elements.length - iconCount;
            const summary = `Found ${elements.length} pressable elements (${iconCount} icon-only, ${labeledCount} with text labels)`;
            const text = [summary, "", ...lines].join("\n");
    
            return {
                content: [{ type: "text", text }]
            };
        }
    );

    // Tool: Get current screen state — route, overlays, pressables (post-navigation checkpoint)
    registerToolWithTelemetry(
        server,
        "get_screen_state",
        {
            description:
                "Get the current screen orientation snapshot: active route name + params, any blocking overlays (bottom sheets, modals, alerts) and their tappable elements, and all pressable elements currently reachable. " +
                "Call this after any tap or navigation to orient before the next action. " +
                "Returns a compact summary: route line (name + stack, params when present), then one line per pressable with center coordinates (x, y), custom component name as a JSX tag (greppable in the codebase), label, testID, and frame bounds. " +
                "When overlays are present, root-level pressables covered by an overlay are listed under a 🚫 Blocked section — visible for context, but taps will NOT reach them until the overlay closes.\n\n" +
                "WHEN TO USE: After every tap or swipe that may have triggered navigation. Replaces the get_pressable_elements + screenshot OCR pattern for orientation.\n" +
                "LIMITATIONS: route is null when the app uses no React Navigation or Expo Router. Requires a live Metro connection. Coordinates are in points (iOS) / dp (Android).\n" +
                "SEE ALSO: get_pressable_elements for raw pressable list without route context; get_screen_layout for full component tree with bounds.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ device }) => {
            if (!hasMetro()) {
                const hint = await metroMissingHintIfAbsent("get_screen_state");
                return {
                    content: [{ type: "text", text: `get_screen_state unavailable.${hint}` }],
                    isError: true
                };
            }

            const result = await getScreenState({ device });

            const metaNotes = collectMetaNotes(result);

            if (!result.success) {
                const errText = metaNotes.length > 0
                    ? `Error: ${result.error}\n\n${metaNotes.join("\n")}`
                    : `Error: ${result.error}`;
                return {
                    content: [{ type: "text", text: errText }],
                    isError: true
                };
            }

            const ss = result.screenState;
            const summary = ss ? formatScreenStateSummary(ss) : (result.result ?? "{}");
            const body = metaNotes.length > 0
                ? `${summary}\n\n${metaNotes.join("\n")}`
                : summary;
            return { content: [{ type: "text", text: body }] };
        }
    );

    function formatPressablesInPixels(
        elements: NonNullable<Awaited<ReturnType<typeof getPressableElements>>["parsedElements"]>,
        opts: {
            platform: "ios" | "android";
            devicePixelRatio: number;
            screenshotScale: number;
            safeAreaTop: number;
        }
    ): string[] {
        const { platform, devicePixelRatio, screenshotScale, safeAreaTop } = opts;
        const out: string[] = [];
        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            // react-native-screens modal presentations report y relative to content origin;
            // shift into the window frame when the element's center sits inside the safe-area
            // band. The shift MUST be applied to center and frame atomically — independent
            // checks (cy<inset, fy<inset) drift apart on iPad-style insets where a header's
            // center is just below the inset but its frame top is just above, producing
            // center/frame.y values that don't satisfy center = frame.y + frame.h/2.
            let cy = el.center.y;
            let fy = el.frame.y;
            if (platform === "ios" && safeAreaTop > 0 && cy < safeAreaTop) {
                cy += safeAreaTop;
                fy += safeAreaTop;
            }
            // iOS: fiber returns points → convert points × DPR / screenshotScale = JPEG px.
            // Android: getPressableElements reconciles fiber DP against uiautomator device-pixel
            // bounds (executor.ts, 2026-05-17). After reconciliation, coords are already in
            // device pixels — only the JPEG downscale needs to be applied. Multiplying by DPR
            // here would re-inflate them by ~density/160 (~2.6× on a 420dpi device), reproducing
            // the original out-of-bounds bug.
            const toPx = (v: number) =>
                platform === "android"
                    ? Math.round(v / screenshotScale)
                    : Math.round((v * devicePixelRatio) / screenshotScale);
            const cx = toPx(el.center.x);
            const cyPx = toPx(cy);
            const fx = toPx(el.frame.x);
            const fyPx = toPx(fy);
            const fw = toPx(el.frame.width);
            const fh = toPx(el.frame.height);
    
            const num = i + 1;
            const iconHint = !el.hasLabel ? iconLabel(el.component, el.icon) : null;
            const label = el.hasLabel
                ? `"${el.text}"`
                : iconHint
                  ? `(${iconHint})`
                  : el.intent
                    ? `(${el.intent} icon)`
                    : "(icon/image)";
            const ids: string[] = [];
            if (el.testID) ids.push(`testID="${el.testID}"`);
            if (el.accessibilityLabel) ids.push(`a11y="${el.accessibilityLabel}"`);
            const idStr = ids.length > 0 ? ` [${ids.join(", ")}]` : "";
            const inputStr = el.isInput ? " (input)" : "";
            const wrapperStr = el.isWrapper ? " [wrapper — skip unless dismissing keyboard]" : "";
            const nearPart = el.nearbyText ? ` near "${el.nearbyText}"` : "";
            out.push(
                `${num}. ${el.component} ${label}${nearPart} — center:(${cx},${cyPx}) frame:(${fx},${fyPx} ${fw}x${fh})${idStr}${inputStr}${wrapperStr}`
            );
            if (el.path) out.push(`   path: ${el.path}`);
        }
        return out;
    }
    
    // Tool: Inspect a specific component by name
    registerToolWithTelemetry(
        server,
        "inspect_component",
        {
            description:
                "Inspect a specific React component by name. **DRILL-DOWN TOOL**: Use after get_screen_layout or find_components to identify which component to inspect. Returns props, style, state (hooks), and optionally children tree. Use childrenDepth to control how deep nested children go." +
                primaryInteractionBanner() + "\n" +
                "PURPOSE: Reveal a mounted component's live props, hook state, and (optionally) child subtree so you can reason about why it renders the way it does.\n" +
                "WHEN TO USE: User asks \"why is this button disabled\", \"what props does X receive\", or you need to confirm state changed after a tap.\n" +
                "WORKFLOW: get_screen_layout or find_components -> inspect_component(componentName=\"Foo\") -> tap or execute_in_app to change state -> inspect_component again.\n" +
                "LIMITATIONS: Requires the component to be currently mounted in the fiber tree. Name matching is exact; use find_components for fuzzy/regex lookup.\n" +
                "GOOD: inspect_component({ componentName: \"SneakerCard\", index: 0 })\n" +
                "BAD: inspect_component({ componentName: \"Card\" }) when many Card instances exist — pass index or narrow via find_components.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
            inputSchema: {
                componentName: z
                    .string()
                    .describe("Name of the component to inspect (e.g., 'Button', 'HomeScreen', 'FlatList')"),
                index: z
                    .number()
                    .optional()
                    .default(0)
                    .describe("If multiple instances exist, which one to inspect (0-based index, default: 0)"),
                includeState: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Include component state/hooks (default: true)"),
                includeChildren: z.boolean().optional().default(false).describe("Include children component tree"),
                childrenDepth: z
                    .number()
                    .optional()
                    .default(1)
                    .describe(
                        "How many levels deep to show children (default: 1 = direct children only, 2+ = nested tree)"
                    ),
                includeStyle: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        "Include flattened style on each child entry (only with includeChildren). Use when debugging 'why isn't X style applying' or cascade-like inheritance on nested elements (e.g., textAlign on an inner Text, flex on a wrapper View). Resolves StyleSheet IDs and array/conditional styles to a single object. Default: false."
                    ),
                shortPath: z.boolean().optional().default(true).describe("Show only last 3 path segments (default: true)"),
                simplifyHooks: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Simplify hooks output by hiding effects and reducing depth (default: true)"),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices."),
                timeoutMs: z.coerce
                    .number()
                    .optional()
                    .describe("Per-call timeout in milliseconds. Default: 5000. Hard cap: 120000.")
            }
        },
        async ({ componentName, index, includeState, includeChildren, childrenDepth, includeStyle, shortPath, simplifyHooks, device, timeoutMs }) => {
            const effectiveTimeoutMs = timeoutMs ?? 5000;
            const result = await inspectComponent(componentName, {
                index,
                includeState,
                includeChildren,
                childrenDepth,
                includeStyle,
                shortPath,
                simplifyHooks,
                device,
                timeoutMs: effectiveTimeoutMs
            });

            const metaNotes = collectMetaNotes(result);

            if (!result.success) {
                const errText = metaNotes.length > 0 ? `Error: ${result.error}\n\n${metaNotes.join("\n")}` : `Error: ${result.error}`;
                return {
                    content: [{ type: "text", text: errText }],
                    isError: true
                };
            }

            const body = metaNotes.length > 0
                ? `Component Inspection: ${componentName}\n\n${result.result}\n\n${metaNotes.join("\n")}`
                : `Component Inspection: ${componentName}\n\n${result.result}`;
            return { content: [{ type: "text", text: body }] };
        }
    );
    
    // Tool: Find components matching a pattern
    registerToolWithTelemetry(
        server,
        "find_components",
        {
            description:
                "Find components matching a name pattern. **TARGETED SEARCH**: Use after get_screen_layout or get_component_tree(structureOnly=true) to find specific components by pattern. Use includeLayout=true to get padding/margin/flex styles." +
                primaryInteractionBanner() + "\n" +
                "PURPOSE: Fast regex search over the entire fiber tree — including off-screen and wrapper components — to locate every instance of a component by name.\n" +
                "WHEN TO USE: You know roughly what the component is called (e.g., \"Button\", \"Screen$\") but not where it lives, or you need counts/paths before drilling in with inspect_component.\n" +
                "WORKFLOW: get_screen_layout (orient) -> find_components(pattern=\"...\") -> inspect_component(componentName=\"...\", index=N).\n" +
                "LIMITATIONS: Matches the React display name only; minified builds may return opaque names. Large result sets — use maxResults or a tighter pattern.\n" +
                "GOOD: find_components({ pattern: \"Button\" }); find_components({ pattern: \"Screen$\" })\n" +
                "BAD: find_components({ pattern: \".*\" }) — floods the response; narrow the regex.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
            inputSchema: {
                pattern: z
                    .string()
                    .describe(
                        "Regex pattern to match component names (case-insensitive). Examples: 'Button', 'Screen$', 'List.*Item'"
                    ),
                maxResults: z.number().optional().default(20).describe("Maximum number of results to return (default: 20)"),
                includeLayout: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include layout styles (padding, margin, flex) for each matched component"),
                shortPath: z.boolean().optional().default(true).describe("Show only last 3 path segments (default: true)"),
                summary: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Return only component counts by name instead of full list (default: false)"),
                format: z
                    .enum(["json", "tonl"])
                    .optional()
                    .default("tonl")
                    .describe("Output format: 'json' or 'tonl' (default, pipe-delimited rows, ~40% smaller)"),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices."),
                timeoutMs: z.coerce
                    .number()
                    .optional()
                    .describe("Per-call timeout in milliseconds. Default: 5000. Hard cap: 120000.")
            }
        },
        async ({ pattern, maxResults, includeLayout, shortPath, summary, format, device, timeoutMs }) => {
            const effectiveTimeoutMs = timeoutMs ?? 5000;
            const result = await findComponents(pattern, {
                maxResults, includeLayout, shortPath, summary, format, device,
                timeoutMs: effectiveTimeoutMs,
            });

            const metaNotes = collectMetaNotes(result);

            if (!result.success) {
                const errText = metaNotes.length > 0 ? `Error: ${result.error}\n\n${metaNotes.join("\n")}` : `Error: ${result.error}`;
                return {
                    content: [{ type: "text", text: errText }],
                    isError: true
                };
            }

            const body = metaNotes.length > 0
                ? `Find Components (pattern: "${pattern}"):\n\n${result.result}\n\n${metaNotes.join("\n")}`
                : `Find Components (pattern: "${pattern}"):\n\n${result.result}`;
            return { content: [{ type: "text", text: body }] };
        }
    );
    
    // Tool: Toggle Element Inspector programmatically
    registerToolWithTelemetry(
        server,
        "toggle_element_inspector",
        {
            description:
                "Toggle React Native's Element Inspector overlay on/off. Rarely needed directly — get_inspector_selection auto-toggles the overlay on for capture and back off afterward. Use only for edge cases (e.g., leaving the overlay visible on screen for a user-facing screenshot).\n" +
                "PURPOSE: Manual control over the on-device inspector overlay.\n" +
                "WHEN TO USE: Only for special cases like capturing a screenshot WITH the inspector visible. Normal inspection workflows should call get_inspector_selection directly.\n" +
                "SEE ALSO: call get_usage_guide(topic=\"inspect\") for the full component-inspect playbook.",
            inputSchema: {
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ device }) => {
            const result = await toggleElementInspector(device);
    
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error}`
                        }
                    ],
                    isError: true
                };
            }
    
            try {
                const parsed = JSON.parse(result.result || "{}");
                if (parsed.error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to toggle Element Inspector: ${parsed.error}`
                            }
                        ],
                        isError: true
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: parsed.message || "Element Inspector toggled successfully"
                        }
                    ]
                };
            } catch {
                return {
                    content: [
                        {
                            type: "text",
                            text: result.result || "Element Inspector toggled"
                        }
                    ]
                };
            }
        }
    );
    
    // Tool: Get currently selected element from Element Inspector
    registerToolWithTelemetry(
        server,
        "get_inspector_selection",
        {
            description:
                "Identify the React component at a screen location AND read its full styling. Returns RN's curated owner-tree hierarchy with per-component STYLE (padding, margin, border, layout, colors, fontSize, etc.) — the same data the on-device Element Inspector shows. Works on Bridgeless/new arch by invoking RN's inspector programmatically. With x/y: toggles the overlay on, captures, toggles it off. Without coordinates: reads the current selection from a manually-driven overlay.\n" +
                "PURPOSE: Identity + styling — \"what is this and how is it styled?\" The primary tool for visual/style debugging at a coordinate.\n" +
                "WHEN TO USE: You see a visual issue at a pixel and want the component name AND its style values (e.g. \"why is borderRadius 14 instead of 16?\").\n" +
                "WORKFLOW: screenshot → note suspect pixel → get_inspector_selection(x, y) → edit returned style values.\n" +
                "LIMITATIONS: Requires RN dev mode. Brief overlay flicker (~600ms). Source paths are null on React 19 (where _debugSource was dropped); name + style is always returned.\n" +
                "VS inspect_at_point: this returns RICH STYLE per ancestor but only ONE frame. inspect_at_point returns FRAME PER ANCESTOR + PROPS but no rich style merging.\n" +
                "SEE ALSO: get_usage_guide(topic=\"inspect\") for the full playbook.",
            inputSchema: {
                x: z
                    .number()
                    .optional()
                    .describe("X coordinate (in points). If provided with y, auto-taps at this location."),
                y: z
                    .number()
                    .optional()
                    .describe("Y coordinate (in points). If provided with x, auto-taps at this location."),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ x, y, device }) => {
            if (!hasMetro()) {
                const hint = await metroMissingHintIfAbsent("get_inspector_selection");
                return {
                    content: [{ type: "text", text: `Inspector selection unavailable.${hint}` }],
                    isError: true
                };
            }
    
            // Coordinate path: use fiber-based hit testing (works on Bridgeless / new arch
            // where RN's built-in inspector cannot populate hierarchy via UIManager.findSubviewIn).
            // Avoids toggling the on-device overlay so screenshots stay clean.
            const result =
                x !== undefined && y !== undefined
                    ? await getInspectorSelectionAtPoint(x, y, device)
                    : await getInspectorSelection(device);
    
            if (!result.success) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    isError: true
                };
            }
    
            try {
                const parsed = JSON.parse(result.result || "{}");
                if (parsed.error) {
                    const hint = parsed.hint ? `\n\n${parsed.hint}` : "";
                    return {
                        content: [{ type: "text", text: `${parsed.error}${hint}` }],
                        isError: true
                    };
                }
    
                let output = `Element: ${parsed.element}\n`;
                output += `Path: ${parsed.path}\n`;
                if (parsed.frame) {
                    const f = parsed.frame;
                    output += `Frame: (${f.left?.toFixed(1)}, ${f.top?.toFixed(1)}) ${f.width?.toFixed?.(1) ?? f.width}x${f.height?.toFixed?.(1) ?? f.height}\n`;
                }
                if (parsed.style) {
                    output += `Style: ${JSON.stringify(parsed.style, null, 2)}\n`;
                }
                if (Array.isArray(parsed.hierarchy) && parsed.hierarchy.length > 0) {
                    output += `\nHierarchy:\n`;
                    for (const h of parsed.hierarchy as Array<{ name: string; source?: string; style?: Record<string, unknown> }>) {
                        output += `  - ${h.name}`;
                        if (h.source) output += `  (${h.source})`;
                        output += `\n`;
                        if (h.style && Object.keys(h.style).length > 0) {
                            const styleStr = JSON.stringify(h.style);
                            output += `      style: ${styleStr.length > 300 ? styleStr.slice(0, 300) + "…" : styleStr}\n`;
                        }
                    }
                }
    
                return {
                    content: [{ type: "text", text: output }]
                };
            } catch {
                return {
                    content: [{ type: "text", text: result.result || "No selection data" }]
                };
            }
        }
    );
    
    // Tool: Inspect component at coordinates (like Element Inspector)
    registerToolWithTelemetry(
        server,
        "inspect_at_point",
        {
            description:
                "Inspect layout AND props at (x, y). Returns FRAME PER ANCESTOR (position/size in dp for every ancestor that hit-tested the point) + the innermost component's PROPS (handlers as [Function], refs, custom props like onPress/data/testID). Pure JS hit-test via fiber + measureInWindow — no overlay toggled, zero visual side effect. Works on Paper and Fabric.\n" +
                "PURPOSE: Layout/props diagnosis — \"where is each ancestor positioned, and what props does the touched component expose?\"\n" +
                "WHEN TO USE: A button is clipped, hit area is wrong, animated frame is unexpected — or you need handler/ref/non-style props. Also preferred for tight loops (no overlay flicker).\n" +
                "WORKFLOW: screenshot → suspect pixel → divide by pixel ratio → inspect_at_point(x, y).\n" +
                "LIMITATIONS: Coordinates MUST be in dp, not screenshot pixels — wrong unit = wrong node. Style is shown for reference only (no rich merging); for style debugging use get_inspector_selection.\n" +
                "VS get_inspector_selection: this returns FRAME PER ANCESTOR + PROPS, no flicker. Inspector returns RICH STYLE per ancestor but only one frame and briefly toggles the overlay.\n" +
                "SEE ALSO: get_usage_guide(topic=\"inspect\") for the full playbook.",
            inputSchema: {
                x: z
                    .number()
                    .describe(
                        "X coordinate in dp (logical pixels). Convert from screenshot pixels by dividing by the device pixel ratio."
                    ),
                y: z
                    .number()
                    .describe(
                        "Y coordinate in dp (logical pixels). Convert from screenshot pixels by dividing by the device pixel ratio."
                    ),
                includeProps: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Include component props in the output (default: true)"),
                includeFrame: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Include position/dimensions (frame) in the output (default: true)"),
                device: z.string().optional().describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ x, y, includeProps, includeFrame, device }) => {
            const result = await inspectAtPoint(x, y, { includeProps, includeFrame, device });
    
            if (!result.success) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: ${result.error}`
                        }
                    ],
                    isError: true
                };
            }
    
            // Parse the result to check for errors in the response
            try {
                const parsed = JSON.parse(result.result || "{}");
                if (parsed.error) {
                    const hint = parsed.hint ? `\n\n${parsed.hint}` : "";
                    const alternatives = parsed.alternatives
                        ? `\n\nAlternatives:\n${parsed.alternatives.map((a: string) => `  - ${a}`).join("\n")}`
                        : "";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Inspect at (${x}, ${y}): ${parsed.error}${hint}${alternatives}`
                            }
                        ],
                        isError: true
                    };
                }
            } catch {
                // If parsing fails, just return the raw result
            }
    
            return {
                content: [
                    {
                        type: "text",
                        text: `Element at (${x}, ${y}):\n\n${result.result}`
                    }
                ]
            };
        }
    );

    // Tool: Measure on-screen geometry of a named component
    registerToolWithTelemetry(
        server,
        "measure",
        {
            description:
                "Get on-screen geometry {x, y, width, height} for a named React component instance. Calls measureInWindow on the matched fiber (or its nearest host descendant for composite components). Coordinates are in points (iOS) / dp (Android), same space as get_screen_layout and inspect_at_point.\n" +
                "PURPOSE: One-shot, name-based component measurement — avoids hand-rolling fiber walks and Promise-wrapping measureInWindow callbacks in execute_in_app.\n" +
                "WHEN TO USE: You already know the component's display name (from get_screen_layout or find_components) and just need its current bounds — e.g. to verify a layout change, compute a tap target, or compare against design specs.\n" +
                "WORKFLOW: find_components(pattern=\"...\") -> measure(componentName=\"...\", index=N) -> tap(x, y) at the center, or inspect_at_point at the center to verify identity.\n" +
                "LIMITATIONS: Returns post-layout on-screen geometry only — for static style use find_components({ includeLayout: true }). For point-based lookup use inspect_at_point. Off-screen fibers may return zeros; that's the truth, not an error. Composites with multiple host descendants return the first host descendant's bounds.\n" +
                "GOOD: measure({ componentName: \"SneakerCard\", index: 0 })\n" +
                "BAD: measure({ componentName: \"View\" }) — too generic; narrow with find_components first.\n" +
                "SEE ALSO: inspect_at_point for point-based variant; find_components({ includeLayout: true }) for static style; get_usage_guide(topic=\"inspect\") for the full playbook.",
            inputSchema: {
                componentName: z
                    .string()
                    .describe("Exact React display name to match (same matcher as inspect_component)."),
                index: z
                    .number()
                    .optional()
                    .default(0)
                    .describe("0-based index when multiple instances match (default: 0)."),
                device: z
                    .string()
                    .optional()
                    .describe("Target device name (substring match). Omit for default device. Run get_apps to see connected devices.")
            }
        },
        async ({ componentName, index, device }) => {
            if (!hasMetro()) {
                const hint = await metroMissingHintIfAbsent("measure");
                return {
                    content: [{ type: "text", text: `measure unavailable.${hint}` }],
                    isError: true
                };
            }

            const result = await measureComponent(componentName, index ?? 0, device);

            if (!result.success) {
                return {
                    content: [{ type: "text", text: `Error: ${result.error}` }],
                    isError: true,
                    _errorContext: result.outcome
                };
            }

            const lines = [
                `Component: ${result.name}`,
                `Frame: (${result.x.toFixed(1)}, ${result.y.toFixed(1)}) ${result.width.toFixed(1)}x${result.height.toFixed(1)}`,
                `Center: (${(result.x + result.width / 2).toFixed(1)}, ${(result.y + result.height / 2).toFixed(1)})`,
            ];
            if (typeof result.nativeTag === "number") {
                lines.push(`nativeTag: ${result.nativeTag}`);
            }

            return {
                content: [{ type: "text", text: lines.join("\n") }]
            };
        }
    );
}
