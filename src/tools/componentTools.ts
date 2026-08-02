import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolWithTelemetry } from "../core/register.js";
import { iconLabel } from "../core/iconSemantics.js";
import {
    getComponentTree,
    getScreenLayout,
    getPressableElements,
    getScreenState,
    formatScreenStateSummary,
    inspectComponent,
    findComponents,
    harvestStacksAtPoint,
    enrichWithSource,
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
} from "../core/index.js";
import { readKeyboardState } from "../core/keyboardMetrics.js";
import { primaryInteractionBanner } from "../core/toolHelpers.js";
import type { ExecutionResult } from "../core/types.js";
import { DEVICE_ARG_DESC } from "./_deviceArg.js";

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
                "Get a screen map showing visible components as an indented tree with actual screen positions. Uses measureInWindow for real coordinates and filters out off-screen components. Returns meaningful component names with text content and frame data (x,y width x height). Coordinates are in **points** (iOS) or **dp** (Android) — NOT screenshot pixels. Use extended=true to include layout styles (padding, margin, flex, backgroundColor, etc.)." +
                primaryInteractionBanner() + "\n" +
                "PURPOSE: Quickest textual map of what is actually on screen right now — component names, positions, and text — so you can plan taps and inspections without guessing.\n" +
                "WHEN TO USE: First step whenever the user asks \"what's on screen\", \"why is X covering Y\", or before tapping a visually ambiguous element.\n" +
                "WORKFLOW: get_screen_layout -> find_components(pattern=\"...\") or inspect_component(componentName=\"...\") -> tap(testID=...) -> get_screen_layout again to confirm.\n" +
                "LIMITATIONS: pass coordinates straight to tap(), which handles conversion — never multiply by devicePixelRatio yourself.\n" +
                "GOOD: get_screen_layout({ extended: true })\n" +
                "BAD: get_screen_layout({ summary: true }) when you actually need to pick a specific element — summary hides the tree.\n" +
                "SOURCE: file:line for an element? inspect_at_point(x, y).\n",
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
                device: z.string().optional().describe(DEVICE_ARG_DESC),
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
                "Get the React component tree from the running app — the fiber hierarchy including providers, navigation wrappers, and internal components. For a screen overview with positions and text, use get_screen_layout instead. Returns compact names-only structure by default; pass structureOnly=false for the full detailed tree.\n" +
                "PURPOSE: Expose the entire fiber tree — including providers, navigators, and off-screen subtrees — when get_screen_layout's visible-only view isn't enough.\n" +
                "WHEN TO USE: Debugging context propagation, navigation wrappers, hidden modals, or when you need to understand the full React architecture.\n" +
                "WORKFLOW: get_component_tree() for overview -> find_components for targeted lookup -> inspect_component for props/state.\n" +
                "LIMITATIONS: The detailed tree (structureOnly=false) is very large and routinely exceeds response-size limits on real apps — reach for inspect_component on a specific node instead. Ignores non-React native views. Minified builds return display names that may be opaque.\n" +
                "GOOD: get_component_tree()\n" +
                "BAD: get_component_tree({ structureOnly: false, includeProps: true, includeStyles: true }) on a large app — prefer inspect_component for specific nodes.\n",
            inputSchema: {
                structureOnly: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        "Return ultra-compact structure with just component names (no props, styles, or paths). Default true — the detailed tree averages tens of thousands of tokens and is rarely what you want. Set false only when you specifically need props/styles/paths for the whole tree."
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
                    .enum(["json", "compact"])
                    .optional()
                    .default("compact")
                    .describe(
                        "Output format: 'json' or 'compact' (default, indented tree — roughly 6x smaller than json). Ignored if structureOnly=true."
                    ),
                device: z.string().optional().describe(DEVICE_ARG_DESC),
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
    
    // Tool: Get current screen state — route, overlays, pressables (post-navigation checkpoint)
    registerToolWithTelemetry(
        server,
        "get_screen_state",
        {
            description:
                "Screenshot-free snapshot of the current screen: active route + params, blocking overlays (sheets, modals, alerts), and every on-screen element merged top-to-bottom within reachability groups. Call after any tap or navigation to orient before the next action. " +
                "Each line carries an (x, y) center + frame bounds (so anything is a tap(x, y) target), typed by a leading marker: 🔘 pressable (with component JSX tag, label, testID, onPress hint), 📝 text, 🖼 image (with src/alt). " +
                "Elements covered by an open overlay are grouped under 🚫 Blocked — visible for context, but taps will NOT reach them until the overlay closes. Long text truncates to 80 chars (fullText=true for full strings); pressablesOnly=true returns just the lean tappable list.\n\n" +
                "WHEN TO USE: After every tap/swipe that may navigate, and to read screen content (prices, labels, which image loaded) without a screenshot+OCR round-trip.\n" +
                "LIMITATIONS: route is null without React Navigation / Expo Router. Requires a live Metro connection. Coordinates in points (iOS) / dp (Android); text frames are container-level (climb to nearest measurable host).\n" +
                "SOURCE: this lists what is on screen, not where it lives in code — for the file:line that renders an element, call inspect_at_point(x, y).\n" +
                "SEE ALSO: get_screen_layout for the full hierarchical component tree (deep inspection) — this gives a flat, tap-ready content list instead.",
            inputSchema: {
                device: z.string().optional().describe(DEVICE_ARG_DESC),
                pressablesOnly: z.boolean().optional().describe("Return only route + overlays + pressables (the lean orientation snapshot), omitting on-screen text and images. Default false."),
                fullText: z.boolean().optional().describe("Emit each text node's full string instead of the 80-char truncation. Default false.")
            }
        },
        async ({ device, pressablesOnly, fullText }) => {
            if (!hasMetro()) {
                const hint = await metroMissingHintIfAbsent("get_screen_state");
                return {
                    content: [{ type: "text", text: `get_screen_state unavailable.${hint}` }],
                    isError: true
                };
            }

            // In parallel: the keyboard read is a second CDP round trip and has
            // no reason to queue behind the fiber walk. It degrades to
            // { visible: false, error } on failure, so it cannot fail this call.
            const [result, keyboard] = await Promise.all([
                getScreenState({ device }),
                readKeyboardState(device)
            ]);

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
            const summary = ss ? formatScreenStateSummary(ss, undefined, { pressablesOnly, fullText, keyboard }) : (result.result ?? "{}");
            const body = metaNotes.length > 0
                ? `${summary}\n\n${metaNotes.join("\n")}`
                : summary;
            return { content: [{ type: "text", text: body }] };
        }
    );

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
                "BAD: inspect_component({ componentName: \"Card\" }) when many Card instances exist — pass index or narrow via find_components.\n",
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
                device: z.string().optional().describe(DEVICE_ARG_DESC),
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
                "SOURCE: searching by name to find a file? If you can point at it on screen, inspect_at_point(x, y) returns the file and line directly.\n",
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
                visibleOnly: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Skip components inside hidden/inactive navigation scenes (unfocused Drawer/Tab destinations, inactive screens). Default false = search the entire fiber tree."),
                format: z
                    .enum(["json", "compact"])
                    .optional()
                    .default("compact")
                    .describe("Output format: 'json' or 'compact' (default, pipe-delimited rows — roughly 4.5x smaller than json)"),
                device: z.string().optional().describe(DEVICE_ARG_DESC),
                timeoutMs: z.coerce
                    .number()
                    .optional()
                    .describe("Per-call timeout in milliseconds. Default: 5000. Hard cap: 120000.")
            }
        },
        async ({ pattern, maxResults, includeLayout, shortPath, summary, format, device, timeoutMs, visibleOnly }) => {
            const effectiveTimeoutMs = timeoutMs ?? 5000;
            const result = await findComponents(pattern, {
                maxResults, includeLayout, shortPath, summary, format, device,
                timeoutMs: effectiveTimeoutMs, visibleOnly,
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
                "LIMITATIONS: Coordinates MUST be in dp, not screenshot pixels — wrong unit = wrong node. Style is the node's own style object, not the merged cascade.\n" +
                "SOURCE: also returns `source: {file, line, column}` for the component at the point, plus the owner chain as `Source ancestors` (set source=false to skip in tight loops).\n",
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
                device: z.string().optional().describe(DEVICE_ARG_DESC),
                source: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe("Resolve the component's source file and line via Metro symbolication. Default true. Set false to skip in tight loops.")
            }
        },
        async ({ x, y, includeProps, includeFrame, device, source = true }) => {
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

            // Source resolution reuses the same hit-test point, so no extra
            // coordinate translation is needed. Failure only adds a reason line.
            let sourceLine = "";
            if (source) {
                const enriched = await enrichWithSource({}, await harvestStacksAtPoint(x, y, device));
                const loc = enriched.source as { file: string; line: number; column: number } | undefined;
                if (loc) {
                    sourceLine = `\n\nSource: ${loc.file}:${loc.line}:${loc.column}`;
                    // The owner chain answers "which parent renders this?" — the one
                    // thing a single file:line cannot, and the reason to inspect at
                    // all when the innermost node is a shared primitive.
                    const ancestors = enriched.ancestors as
                        | Array<{ component: string; file: string; line: number }>
                        | undefined;
                    if (ancestors && ancestors.length > 1) {
                        sourceLine += `\nSource ancestors:\n`;
                        for (const a of ancestors) {
                            sourceLine += `  - ${a.component}  ${a.file}:${a.line}\n`;
                        }
                    }
                } else {
                    sourceLine = `\n\nSource: unavailable (${enriched.sourceUnavailable})`;
                }
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Element at (${x}, ${y}):\n\n${result.result}${sourceLine}`
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
                "SEE ALSO: inspect_at_point for point-based variant; find_components({ includeLayout: true }) for static style.",
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
                    .describe(DEVICE_ARG_DESC)
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
