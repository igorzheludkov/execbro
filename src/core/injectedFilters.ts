/**
 * Component-name filters shared by every injected fiber walker.
 *
 * These decide which fiber gets to name an element. They MUST be identical
 * across walkers: an agent reads a component name out of get_screen_state and
 * then passes it straight back as an input_text/tap target. If screenState
 * filtered `TextAncestorContext` but the input resolver did not, screenState
 * would print `<InputField />` while the resolver answered to
 * `TextAncestorContext` — and the name the agent could see would be the one
 * name that did not work.
 *
 * Exported as SOURCE STRINGS because they are interpolated into template
 * literals that Hermes compiles, not used as TS RegExp objects. These are
 * ordinary TS strings, so `\\(` here is the value `\(` — which is what must
 * reach the device. (Inside screenState's template literal the same character
 * has to be written `\\(`; the doubling there is template escaping, not part
 * of the pattern.)
 */

/** Internal/framework wrappers that must never be reported as an element's name. */
export const RN_PRIMITIVES_SRC =
    "/^(Animated\\(.*|withAnimated.*|AnimatedComponent.*|ForwardRef.*|memo\\(.*|Context\\.Consumer|Context\\.Provider|ScrollViewContext(Base)?|VirtualizedListContext(Resetter)?|TextInputContext|KeyboardAvoidingViewContext|RCT.*|RNS.*|RNC.*|ViewManagerAdapter_.*|VirtualizedList.*|CellRenderer.*|FrameSizeProvider.*|MaybeScreenContainer|MaybeScreen|Navigation.*|Screen$|ScreenStack|ScreenContainer|ScreenContentWrapper|SceneView|DelayedFreeze|Freeze|Suspender|DebugContainer|StaticContainer|SafeAreaProvider.*|SafeAreaFrameContext|SafeAreaInsetsContext|ExpoRoot|ExpoRootComponent|GestureHandler.*|NativeViewGestureHandler|GestureDetector|PanGestureHandler|Reanimated.*|BottomTabNavigator|TabLayout|RouteNode|Route$|KeyboardProvider|PortalProviderComponent|BottomSheetModalProviderWrapper|ThemeContext|ThemeProvider|TextAncestorContext|PressabilityDebugView|TouchableHighlightImpl|StatusBarOverlay|BottomSheetHostingContainerComponent|BottomSheetGestureHandlersProvider|BottomSheetBackdropContainerComponent|BottomSheetContainerComponent|BottomSheetDraggableViewComponent|BottomSheetHandleContainerComponent|BottomSheetBackgroundContainerComponent|DebuggingOverlay|InspectorDeferred|Inspector|InspectorOverlay|InspectorPanel|StyleInspector|BoxInspector|BoxContainer|ElementBox|BorderBox|InspectorPanelButton)$/";

/** Names too generic to identify anything — keep climbing past these. */
export const GENERIC_COMPONENT_SRC =
    "/^(View|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Pressable|TouchableNativeFeedback|Text|RCTView|RCTText|Unknown)$/";
