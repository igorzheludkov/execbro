# get_pressable_elements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new MCP tool `get_pressable_elements` that returns all visible pressable/input elements with tap-ready coordinates and component names.

**Architecture:** Two-phase JS injection (dispatch measureInWindow, then resolve after 300ms) — same pattern as `getScreenLayout`. New exported function `getPressableElements` in `executor.ts`, new tool registration in `index.ts`.

**Tech Stack:** TypeScript, CDP Runtime.evaluate, React fiber tree, measureInWindow API

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/core/executor.ts` | Add `getPressableElements()` function (~200 lines) and `PressableElement` interface |
| Modify | `src/index.ts` | Register `get_pressable_elements` tool with telemetry |

---

### Task 1: Add `PressableElement` interface and `getPressableElements` function in executor.ts

**Files:**
- Modify: `src/core/executor.ts` — add after `getScreenLayout` function (after line 1697)

- [ ] **Step 1: Add the `PressableElement` interface**

Add this right after the closing `}` of `getScreenLayout` at line 1697, before the existing `EnrichedElement` interface at line 1699:

```typescript
// --- get_pressable_elements ---

interface PressableElement {
    component: string;
    path: string;
    center: { x: number; y: number };
    frame: { x: number; y: number; width: number; height: number };
    text: string;
    testID: string | null;
    accessibilityLabel: string | null;
    hasLabel: boolean;
    isInput: boolean;
}
```

- [ ] **Step 2: Add the `getPressableElements` exported function — Phase 1 (dispatch)**

Add the function right after the `PressableElement` interface:

```typescript
export async function getPressableElements(
    options: { device?: string } = {}
): Promise<ExecutionResult & { parsedElements?: PressableElement[] }> {
    const { device } = options;

    // --- Step 1: walk fiber tree, find pressable/input elements, dispatch measureInWindow ---
    const dispatchExpression = `
        (function() {
            var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found.' };

            var roots = [];
            if (hook.getFiberRoots) {
                roots = Array.from(hook.getFiberRoots(1) || []);
            }
            if (roots.length === 0 && hook.renderers) {
                for (var entry of hook.renderers) {
                    var r = Array.from(hook.getFiberRoots ? (hook.getFiberRoots(entry[0]) || []) : []);
                    if (r.length > 0) { roots = r; break; }
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found.' };

            function getMeasurable(fiber) {
                var sn = fiber.stateNode;
                if (!sn) return null;
                if (typeof sn.measureInWindow === 'function') return sn;
                if (sn.canonical && sn.canonical.publicInstance &&
                    typeof sn.canonical.publicInstance.measureInWindow === 'function') {
                    return sn.canonical.publicInstance;
                }
                return null;
            }

            function findFirstHost(fiber, depth) {
                if (!fiber || depth > 20) return null;
                if (typeof fiber.type === 'string' && getMeasurable(fiber)) return fiber;
                var child = fiber.child;
                while (child) {
                    var found = findFirstHost(child, depth + 1);
                    if (found) return found;
                    child = child.sibling;
                }
                return null;
            }

            function collectText(fiber, d) {
                if (!fiber || d > 30) return '';
                var props = fiber.memoizedProps;
                if (props) {
                    var ch = props.children;
                    if (typeof ch === 'string') return ch;
                    if (typeof ch === 'number') return String(ch);
                    if (Array.isArray(ch)) {
                        var inline = [];
                        for (var ci = 0; ci < ch.length; ci++) {
                            if (typeof ch[ci] === 'string') inline.push(ch[ci]);
                            else if (typeof ch[ci] === 'number') inline.push(String(ch[ci]));
                        }
                        if (inline.length > 0) return inline.join('');
                    }
                }
                var parts = [];
                var child = fiber.child;
                while (child) {
                    var t = collectText(child, d + 1);
                    if (t) parts.push(t);
                    child = child.sibling;
                }
                return parts.join(' ').trim();
            }

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type;
                return fiber.type.displayName || fiber.type.name || null;
            }

            var RN_PRIMITIVES = /^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|RCT.*|RNS.*|RNC.*|ViewManagerAdapter_.*|VirtualizedList.*|CellRenderer.*|FrameSizeProvider.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|SafeAreaProvider.*|SafeAreaFrameContext|SafeAreaInsetsContext|ExpoRoot|ExpoRootComponent|GestureHandler.*|NativeViewGestureHandler|GestureDetector|PanGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|KeyboardProvider|PortalProviderComponent|BottomSheetModalProviderWrapper|ThemeContext|ThemeProvider|TextAncestorContext|PressabilityDebugView|TouchableHighlightImpl|StatusBarOverlay|BottomSheetHostingContainerComponent|BottomSheetGestureHandlersProvider|BottomSheetBackdropContainerComponent|BottomSheetContainerComponent|BottomSheetDraggableViewComponent|BottomSheetHandleContainerComponent|BottomSheetBackgroundContainerComponent|DebuggingOverlay|InspectorDeferred|Inspector|InspectorOverlay|InspectorPanel|StyleInspector|BoxInspector|BoxContainer|ElementBox|BorderBox|InspectorPanelButton)$/;

            var hostFibers = [];
            var fiberMeta = [];

            function findMeaningfulAncestorName(fiber) {
                var cur = fiber.return;
                var depth = 0;
                var fallbackName = null;
                while (cur && depth < 20) {
                    var name = getComponentName(cur);
                    if (name && typeof cur.type !== 'string') {
                        if (!fallbackName) fallbackName = name;
                        if (!RN_PRIMITIVES.test(name)) return name;
                    }
                    cur = cur.return;
                    depth++;
                }
                return fallbackName;
            }

            function buildPath(fiber) {
                var parts = [];
                var cur = fiber;
                var depth = 0;
                while (cur && depth < 30) {
                    var name = getComponentName(cur);
                    if (name && typeof cur.type !== 'string' && !RN_PRIMITIVES.test(name)) {
                        parts.unshift(name);
                    }
                    cur = cur.return;
                    depth++;
                }
                // Keep last 3 segments
                if (parts.length > 3) {
                    parts = parts.slice(-3);
                    return '... > ' + parts.join(' > ');
                }
                return parts.join(' > ');
            }

            function walkPressables(fiber, depth) {
                if (!fiber || depth > 5000) return;
                var name = getComponentName(fiber);
                var props = fiber.memoizedProps;

                // Skip inactive/unfocused screens
                if (name === 'MaybeScreen' && props && props.active === 0) return;
                if (name === 'SceneView' && props && props.focused === false) return;
                if (name === 'RNSScreen' && props && props['aria-hidden'] === true) return;

                var isPressable = props && typeof props.onPress === 'function';
                var isInput = !isPressable && props && (typeof props.onChangeText === 'function' || typeof props.onFocus === 'function');

                if (isPressable || isInput) {
                    var host = findFirstHost(fiber, 0);
                    if (host) {
                        var text = collectText(fiber, 0);
                        var componentName = findMeaningfulAncestorName(fiber) || name || 'Unknown';
                        var path = buildPath(fiber);
                        var testID = (props && (props.testID || props.nativeID)) || null;
                        var accessibilityLabel = (props && props.accessibilityLabel) || null;

                        hostFibers.push(host);
                        fiberMeta.push({
                            component: componentName,
                            path: path,
                            text: text ? text.slice(0, 100) : '',
                            testID: testID,
                            accessibilityLabel: accessibilityLabel,
                            isInput: !!isInput
                        });
                    }
                }

                var child = fiber.child;
                while (child) {
                    walkPressables(child, depth + 1);
                    child = child.sibling;
                }
            }

            walkPressables(roots[0].current, 0);

            if (hostFibers.length === 0) return { error: 'No pressable elements found on screen.' };

            // Also measure the root view for viewport detection
            var rootHost = findFirstHost(roots[0].current, 0);
            if (rootHost) {
                hostFibers.unshift(rootHost);
                fiberMeta.unshift({ component: '__root__', path: '', text: '', testID: null, accessibilityLabel: null, isInput: false });
            }

            globalThis.__pressableFibers = hostFibers;
            globalThis.__pressableMeta = fiberMeta;
            globalThis.__pressableMeasurements = new Array(hostFibers.length).fill(null);

            for (var i = 0; i < hostFibers.length; i++) {
                try {
                    (function(idx) {
                        getMeasurable(hostFibers[idx]).measureInWindow(function(fx, fy, fw, fh) {
                            globalThis.__pressableMeasurements[idx] = { x: fx, y: fy, width: fw, height: fh };
                        });
                    })(i);
                } catch(e) {}
            }

            return { count: hostFibers.length };
        })()
    `;

    const dispatchResult = await executeInApp(dispatchExpression, false, { timeoutMs: 30000 }, device);
    if (!dispatchResult.success) return dispatchResult;

    try {
        const parsed = JSON.parse(dispatchResult.result || "{}");
        if (parsed.error) return { success: false, error: parsed.error };
    } catch {
        /* ignore */
    }

    // Wait for measureInWindow callbacks
    await delay(300);
```

- [ ] **Step 3: Add Phase 2 (resolve measurements) to `getPressableElements`**

Continue the function with the resolve phase:

```typescript
    // --- Step 2: read measurements, filter visible, build results ---
    const resolveExpression = `
        (function() {
            var fibers = globalThis.__pressableFibers;
            var meta = globalThis.__pressableMeta;
            var measurements = globalThis.__pressableMeasurements;
            globalThis.__pressableFibers = null;
            globalThis.__pressableMeta = null;
            globalThis.__pressableMeasurements = null;

            if (!fibers || !measurements || !meta) {
                return { error: 'No measurement data. Run get_pressable_elements again.' };
            }

            // Get viewport dimensions
            var viewportW = 9999, viewportH = 9999;
            for (var v = 0; v < measurements.length; v++) {
                if (measurements[v] && measurements[v].x === 0 && measurements[v].y <= 0 &&
                    measurements[v].width > 0 && measurements[v].height > 0) {
                    viewportW = measurements[v].width;
                    viewportH = measurements[v].height + measurements[v].y;
                    break;
                }
            }

            var elements = [];

            for (var i = 0; i < measurements.length; i++) {
                var m = measurements[i];
                if (!m) continue;

                var info = meta[i];
                // Skip the root viewport measurement entry
                if (info.component === '__root__') continue;

                // Filter: only visible within viewport
                if (m.width <= 0 || m.height <= 0) continue;
                if (m.x + m.width < 0 || m.y + m.height < 0) continue;
                if (m.x > viewportW || m.y > viewportH) continue;

                var text = info.text || '';

                elements.push({
                    component: info.component,
                    path: info.path,
                    center: {
                        x: Math.round(m.x + m.width / 2),
                        y: Math.round(m.y + m.height / 2)
                    },
                    frame: {
                        x: Math.round(m.x),
                        y: Math.round(m.y),
                        width: Math.round(m.width),
                        height: Math.round(m.height)
                    },
                    text: text,
                    testID: info.testID,
                    accessibilityLabel: info.accessibilityLabel,
                    hasLabel: text.length > 0,
                    isInput: info.isInput
                });
            }

            // Sort top-to-bottom, left-to-right
            elements.sort(function(a, b) {
                if (a.center.y !== b.center.y) return a.center.y - b.center.y;
                return a.center.x - b.center.x;
            });

            var iconCount = 0;
            var labeledCount = 0;
            for (var j = 0; j < elements.length; j++) {
                if (elements[j].hasLabel) labeledCount++;
                else iconCount++;
            }

            return {
                pressableElements: elements,
                summary: 'Found ' + elements.length + ' pressable elements (' + iconCount + ' icon-only, ' + labeledCount + ' with text labels)'
            };
        })()
    `;

    const result = await executeInApp(resolveExpression, false, { timeoutMs: 30000 }, device);

    if (result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.error) return { success: false, error: parsed.error };

            const pressableElements: PressableElement[] = parsed.pressableElements || [];

            // Format as readable text
            const lines: string[] = [parsed.summary, ""];
            for (const el of pressableElements) {
                const label = el.hasLabel ? `"${el.text}"` : "(icon/image)";
                const ids: string[] = [];
                if (el.testID) ids.push(`testID="${el.testID}"`);
                if (el.accessibilityLabel) ids.push(`a11y="${el.accessibilityLabel}"`);
                const idStr = ids.length > 0 ? ` [${ids.join(", ")}]` : "";
                const inputStr = el.isInput ? " (input)" : "";
                lines.push(
                    `${el.component} ${label} — center:(${el.center.x},${el.center.y}) frame:(${el.frame.x},${el.frame.y} ${el.frame.width}x${el.frame.height})${idStr}${inputStr}`
                );
                if (el.path) lines.push(`  path: ${el.path}`);
            }

            return {
                success: true,
                result: lines.join("\n"),
                parsedElements: pressableElements
            };
        } catch {
            // If parsing fails, return original result
        }
    }

    return result;
}
```

- [ ] **Step 4: Build and verify no TypeScript errors**

Run:
```bash
npm run build
```
Expected: Compiles successfully with no errors related to `getPressableElements` or `PressableElement`.

- [ ] **Step 5: Commit**

```bash
git add src/core/executor.ts
git commit -m "feat: add getPressableElements function in executor

Two-phase fiber tree traversal that finds all visible pressable/input
elements and returns their coordinates, component names, and text content."
```

---

### Task 2: Register `get_pressable_elements` tool in index.ts

**Files:**
- Modify: `src/index.ts` — add tool registration after `get_screen_layout` (after line 1788)

- [ ] **Step 1: Add the import**

In `src/index.ts`, find the import block from `./core/executor.js` and add `getPressableElements` to it. Search for the existing imports from `./core/executor.js` — they are destructured imports. Add `getPressableElements` to that list.

- [ ] **Step 2: Add the tool registration**

Add this registration block after the `get_screen_layout` tool registration (after line 1788), before the `inspect_component` registration:

```typescript
registerToolWithTelemetry(
    "get_pressable_elements",
    {
        description:
            "Find all pressable (onPress) and input (TextInput) elements currently visible on screen. Returns component names, tap-ready center coordinates (in points/dp), text labels, testID, and accessibilityLabel. Useful when you need to tap an icon or button but can't identify it from a screenshot alone. Each element includes hasLabel (true if it contains text) and isInput (true for TextInput fields).",
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

        return {
            content: [
                {
                    type: "text",
                    text: result.result || "No pressable elements found."
                }
            ]
        };
    }
);
```

- [ ] **Step 3: Build and verify**

Run:
```bash
npm run build
```
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register get_pressable_elements MCP tool

Exposes getPressableElements as a new MCP tool with device parameter
for multi-device targeting."
```

---

### Task 3: Manual testing with a running React Native app

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
npm run dev:mcp
```

- [ ] **Step 2: Test the tool via the dev meta-tool**

Use the `dev` tool in Claude Code to test:
```
dev(action="call", tool="get_pressable_elements", args={})
```

Expected: Returns a list of pressable elements with component names, coordinates, text labels, and the summary line. Verify:
- Icon-only buttons (hamburger menu, back arrow, etc.) appear with `hasLabel: false`
- Text buttons appear with `hasLabel: true` and their text content
- Center coordinates are reasonable (within screen bounds)
- Frames have positive width/height
- Elements are sorted top-to-bottom

- [ ] **Step 3: Test with device parameter**

If multiple devices are connected:
```
dev(action="call", tool="get_pressable_elements", args={"device": "iPhone"})
```

Expected: Returns elements only from the targeted device.

- [ ] **Step 4: Test on a screen with no pressable elements (if possible)**

Navigate to a screen with only static content, then call the tool.

Expected: Returns error message "No pressable elements found on screen."

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add src/core/executor.ts src/index.ts
git commit -m "fix: address issues found during manual testing of get_pressable_elements"
```
