import type { ExecutionResult } from "./types.js";
import { executeInApp } from "./jsExecute.js";
import { VISIBILITY_HELPERS_JS } from "./injected/visibility.js";

// ============================================================================
// React Component Tree (via DevTools Global Hook)
// ============================================================================

interface ComponentTreeNode {
    component: string;
    children?: ComponentTreeNode[];
    props?: Record<string, unknown>;
    layout?: Record<string, unknown>;
}

function formatTreeToTonl(node: ComponentTreeNode, indent = 0): string {
    const prefix = "  ".repeat(indent);
    let result = `${prefix}${node.component}`;

    // Add props inline if present
    if (node.props && Object.keys(node.props).length > 0) {
        const propsStr = Object.entries(node.props)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(",");
        result += ` (${propsStr})`;
    }

    // Add layout inline if present
    if (node.layout && Object.keys(node.layout).length > 0) {
        const layoutStr = Object.entries(node.layout)
            .map(([k, v]) => `${k}:${v}`)
            .join(",");
        result += ` [${layoutStr}]`;
    }

    result += "\n";

    // Recurse children
    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            result += formatTreeToTonl(child, indent + 1);
        }
    }

    return result;
}

// Ultra-compact structure-only tree format (just component names, indented)
function formatTreeStructureOnly(node: ComponentTreeNode, indent = 0): string {
    const prefix = "  ".repeat(indent);
    let result = `${prefix}${node.component}\n`;

    if (node.children && node.children.length > 0) {
        for (const child of node.children) {
            result += formatTreeStructureOnly(child, indent + 1);
        }
    }

    return result;
}

export async function getComponentTree(
    options: {
        maxDepth?: number;
        includeProps?: boolean;
        includeStyles?: boolean;
        hideInternals?: boolean;
        format?: "json" | "tonl";
        structureOnly?: boolean;
        focusedOnly?: boolean;
        device?: string;
        timeoutMs?: number;
    } = {}
): Promise<ExecutionResult> {
    const {
        includeProps = false,
        includeStyles = false,
        hideInternals = true,
        format = "tonl",
        structureOnly = false,
        focusedOnly = false,
        device,
        timeoutMs
    } = options;
    // Use lower default depth for structureOnly to keep output compact (~2-5KB)
    // Full mode uses higher depth since TONL format handles it better
    // focusedOnly mode uses moderate depth since we're already filtering to active screen
    const maxDepth = options.maxDepth ?? 5000;

    const expression = `
        (function() {
            const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            if (!hook) return { error: 'React DevTools hook not found. Make sure you are running a development build.' };

            // Try to get fiber roots (renderer ID is usually 1)
            let roots = [];
            if (hook.getFiberRoots) {
                roots = [...(hook.getFiberRoots(1) || [])];
            }
            if (roots.length === 0 && hook.renderers) {
                // Try all renderers
                for (const [id] of hook.renderers) {
                    const r = hook.getFiberRoots ? [...(hook.getFiberRoots(id) || [])] : [];
                    if (r.length > 0) {
                        roots = r;
                        break;
                    }
                }
            }
            if (roots.length === 0) return { error: 'No fiber roots found. The app may not have rendered yet.' };

            const maxDepth = ${maxDepth};
            const includeProps = ${includeProps};
            const includeStyles = ${includeStyles};
            const hideInternals = ${hideInternals};
            const focusedOnly = ${focusedOnly};

            // Internal RN components to hide
            const internalPatterns = /^(RCT|RNS|Animated\\(|AnimatedComponent|VirtualizedList|CellRenderer|ScrollViewContext|PerformanceLoggerContext|RootTagContext|HeaderShownContext|HeaderHeightContext|HeaderBackContext|SafeAreaFrameContext|SafeAreaInsetsContext|VirtualizedListContext|VirtualizedListCellContextProvider|StaticContainer|DelayedFreeze|Freeze|Suspender|DebugContainer|MaybeNestedStack|SceneView|NavigationContent|PreventRemoveProvider|EnsureSingleNavigator)/;

            // Screen component patterns - user's actual screens (strict matching)
            // Only match *Screen and *Page to avoid false positives like BottomTabView
            const screenPatterns = /^[A-Z][a-zA-Z0-9]*(Screen|Page)$/;

            // Navigation/internal screen patterns to SKIP (these look like screens but are framework components)
            const internalScreenPatterns = /^(MaybeScreen|Screen$|ScreenContainer|ScreenStack|SceneView|Background$)/;

            // Provider/wrapper patterns to skip when finding focused screen
            const wrapperPatterns = /^(App|AppContainer|Provider|Context|SafeArea|Gesture|Theme|Redux|Root|Navigator|Stack|Tab|Drawer|Navigation|Container|Wrapper|Layout|ErrorBoundary|Suspense|PersistGate|LinkingContext|AppState|View|Fragment|NativeStack|BottomTab|Screen$)/i;

            // Global overlay patterns - stop traversing into these subtrees
            // Be specific to avoid blocking BottomSheetDrawer, PortalProvider, etc.
            const overlayPatterns = /^(BottomSheet$|BottomSheetGlobal|Modal$|Toast$|Snackbar$|Dialog$|Overlay$|Popup$|MyToast$|PaywallModal$|FullScreenBannerModal$)/i;

            // Navigation container patterns - skip traversing into these (screens inside are nav screens, not focused content)
            const navContainerPatterns = /^(RootNavigation|NativeStackNavigator|BottomTabNavigator|DrawerNavigator|TabNavigator|StackNavigator)/;

            function getComponentName(fiber) {
                if (!fiber || !fiber.type) return null;
                if (typeof fiber.type === 'string') return fiber.type; // Host component (View, Text, etc.)
                return fiber.type.displayName || fiber.type.name || null;
            }

            ${VISIBILITY_HELPERS_JS}

            function shouldHide(name) {
                if (!hideInternals || !name) return false;
                return internalPatterns.test(name);
            }

            function extractLayoutStyles(style) {
                try {
                    if (!style) return null;
                    const merged = Array.isArray(style)
                        ? Object.assign({}, ...style.filter(Boolean).map(s => {
                            try { return typeof s === 'object' ? s : {}; }
                            catch { return {}; }
                        }))
                        : (typeof style === 'object' ? style : {});

                    const layout = {};
                    const layoutKeys = [
                        'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
                        'paddingHorizontal', 'paddingVertical',
                        'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
                        'marginHorizontal', 'marginVertical',
                        'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
                        'flex', 'flexDirection', 'flexWrap', 'flexGrow', 'flexShrink',
                        'justifyContent', 'alignItems', 'alignSelf', 'alignContent',
                        'position', 'top', 'bottom', 'left', 'right',
                        'gap', 'rowGap', 'columnGap',
                        'borderWidth', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth'
                    ];

                    for (const key of layoutKeys) {
                        if (merged[key] !== undefined) layout[key] = merged[key];
                    }
                    return Object.keys(layout).length > 0 ? layout : null;
                } catch { return null; }
            }

            function walkFiber(fiber, depth) {
                if (!fiber || depth > maxDepth) return null;

                const name = getComponentName(fiber);

                // Skip anonymous/internal components unless they have meaningful children
                if (!name || shouldHide(name)) {
                    // Still traverse children
                    let child = fiber.child;
                    const children = [];
                    while (child) {
                        const childResult = walkFiber(child, depth);
                        if (childResult) children.push(childResult);
                        child = child.sibling;
                    }
                    // Return first meaningful child or null
                    return children.length === 1 ? children[0] : (children.length > 1 ? { component: '(Fragment)', children } : null);
                }

                const node = { component: name };

                // Include props if requested (excluding children and style for cleaner output)
                if (includeProps && fiber.memoizedProps) {
                    const props = {};
                    for (const key of Object.keys(fiber.memoizedProps)) {
                        if (key === 'children' || key === 'style') continue;
                        try {
                            const val = fiber.memoizedProps[key];
                            if (typeof val === 'function') {
                                props[key] = '[Function]';
                            } else if (typeof val === 'object' && val !== null) {
                                props[key] = Array.isArray(val) ? '[Array]' : '[Object]';
                            } else {
                                props[key] = val;
                            }
                        } catch {
                            props[key] = '[Animated Value]';
                        }
                    }
                    if (Object.keys(props).length > 0) node.props = props;
                }

                // Include layout styles if requested
                try {
                    if (includeStyles && fiber.memoizedProps?.style) {
                        const layout = extractLayoutStyles(fiber.memoizedProps.style);
                        if (layout) node.layout = layout;
                    }
                } catch { /* animated style — skip */ }

                // Traverse children
                let child = fiber.child;
                const children = [];
                while (child) {
                    const childResult = walkFiber(child, depth + 1);
                    if (childResult) children.push(childResult);
                    child = child.sibling;
                }
                if (children.length > 0) node.children = children;

                return node;
            }

            // Find focused screen if requested
            function findFocusedScreen(fiber, depth = 0) {
                if (!fiber || depth > 5000) return null;

                const name = getComponentName(fiber);

                // Skip hidden/inactive navigation scenes (unfocused drawer/tab destinations) so
                // the focused screen — not an off-screen sibling found earlier in DFS — is returned.
                if (isHiddenNavigationScene(name, fiber.memoizedProps)) return null;

                // Skip overlays (BottomSheet, Modal, Toast, etc.) - don't traverse into them
                if (name && overlayPatterns.test(name)) {
                    return null;
                }

                // Skip navigation containers - screens inside are nav screens, not focused content
                if (name && navContainerPatterns.test(name)) {
                    return null;
                }

                // Check if this is a user's screen component (not framework internals)
                if (name && screenPatterns.test(name) && !wrapperPatterns.test(name) && !internalScreenPatterns.test(name)) {
                    return fiber;
                }

                // Search children
                let child = fiber.child;
                while (child) {
                    const found = findFocusedScreen(child, depth + 1);
                    if (found) return found;
                    child = child.sibling;
                }

                return null;
            }

            let startFiber = roots[0].current;
            let focusedScreenName = null;

            if (focusedOnly) {
                const focused = findFocusedScreen(roots[0].current);
                if (focused) {
                    startFiber = focused;
                    focusedScreenName = getComponentName(focused);
                }
            }

            const tree = walkFiber(startFiber, 0);

            if (focusedOnly && focusedScreenName) {
                return { focusedScreen: focusedScreenName, tree };
            }
            return { tree };
        })()
    `;

    // Use a longer timeout for component tree traversal — large apps can exceed 10s
    const result = await executeInApp(expression, false, { timeoutMs: timeoutMs ?? 30000, originatingToolName: "get_component_tree" }, device);

    // Apply formatting if requested
    if (result.success && result.result) {
        try {
            const parsed = JSON.parse(result.result);
            if (parsed.tree) {
                const prefix = parsed.focusedScreen ? `Focused: ${parsed.focusedScreen}\n\n` : "";

                // Structure-only mode: ultra-compact format with just component names
                if (structureOnly) {
                    const structure = formatTreeStructureOnly(parsed.tree);
                    return { success: true, result: prefix + structure };
                }
                // TONL format: compact with props/layout
                if (format === "tonl") {
                    const tonl = formatTreeToTonl(parsed.tree);
                    return { success: true, result: prefix + tonl };
                }
            }
        } catch {
            // If parsing fails, return original result
        }
    }

    return result;
}
