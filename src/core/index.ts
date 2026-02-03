// Types
export * from "./types.js";

// Connection State Management
export {
    DEFAULT_RECONNECTION_CONFIG,
    initConnectionState,
    updateConnectionState,
    getConnectionState,
    getAllConnectionStates,
    recordConnectionGap,
    closeConnectionGap,
    getRecentGaps,
    hasRecentDisconnect,
    saveConnectionMetadata,
    getConnectionMetadata,
    clearConnectionMetadata,
    getAllConnectionMetadata,
    saveReconnectionTimer,
    getAndClearReconnectionTimer,
    cancelReconnectionTimer,
    cancelAllReconnectionTimers,
    clearAllConnectionState,
    calculateBackoffDelay,
    formatDuration,
    // Context health tracking
    initContextHealth,
    getContextHealth,
    updateContextHealth,
    markContextStale,
    markContextHealthy,
    clearContextHealth,
    getAllContextHealth,
} from "./connectionState.js";

// State
export { logBuffer, networkBuffer, bundleErrorBuffer, connectedApps, pendingExecutions, getNextMessageId, getActiveSimulatorUdid } from "./state.js";

// Logs
export { LogBuffer, mapConsoleType, formatLogs, getLogs, searchLogs, getLogSummary } from "./logs.js";

// Network
export {
    NetworkBuffer,
    formatRequest,
    formatRequests,
    formatRequestDetails,
    getNetworkRequests,
    searchNetworkRequests,
    getNetworkStats
} from "./network.js";

// Metro
export {
    COMMON_PORTS,
    isPortOpen,
    scanMetroPorts,
    fetchDevices,
    selectMainDevice,
    discoverMetroDevices,
    checkMetroState
} from "./metro.js";

export type { MetroState } from "./metro.js";

// Connection
export {
    formatRemoteObject,
    handleCDPMessage,
    connectToDevice,
    getConnectedApps,
    getFirstConnectedApp,
    hasConnectedApp,
    runQuickHealthCheck,
    ensureConnection,
} from "./connection.js";

// Executor
export { executeInApp, listDebugGlobals, inspectGlobal, reloadApp } from "./executor.js";

// Android (ADB)
export {
    isAdbAvailable,
    listAndroidDevices,
    getDefaultAndroidDevice,
    androidScreenshot,
    androidInstallApp,
    androidLaunchApp,
    androidListPackages,
    // UI Input (Phase 2)
    ANDROID_KEY_EVENTS,
    androidTap,
    androidLongPress,
    androidSwipe,
    androidInputText,
    androidKeyEvent,
    androidGetScreenSize,
    androidGetDensity,
    androidGetStatusBarHeight,
    // Accessibility (UI Hierarchy)
    androidDescribeAll,
    androidDescribePoint,
    androidTapElement,
    // UI Accessibility (Element Finding)
    androidGetUITree,
    androidFindElement,
    androidWaitForElement
} from "./android.js";

// Android types
export type {
    AndroidAccessibilityElement,
    AndroidDescribeResult,
    AndroidUIElement,
    FindElementResult,
    WaitForElementResult,
    FindElementOptions
} from "./android.js";

// iOS (simctl + IDB)
export {
    // simctl-based tools
    isSimctlAvailable,
    listIOSSimulators,
    getBootedSimulatorUdid,
    findSimulatorByName,
    getActiveOrBootedSimulatorUdid,
    iosScreenshot,
    iosInstallApp,
    iosLaunchApp,
    iosOpenUrl,
    iosTerminateApp,
    iosBootSimulator,
    // IDB-based UI tools
    isIdbAvailable,
    iosTap,
    iosTapElement,
    iosSwipe,
    iosInputText,
    iosButton,
    iosKeyEvent,
    iosKeySequence,
    iosDescribeAll,
    iosDescribePoint,
    IOS_BUTTON_TYPES,
    // UI Accessibility (Element Finding) - Requires IDB
    iosGetUITree,
    iosFindElement,
    iosWaitForElement
} from "./ios.js";

// iOS types
export type {
    iOSButtonType,
    iOSAccessibilityElement,
    iOSDescribeResult,
    IOSUIElement,
    IOSFindElementResult,
    IOSWaitForElementResult,
    IOSFindElementOptions
} from "./ios.js";

// Bundle (Metro build errors)
export {
    BundleErrorBuffer,
    parseMetroError,
    formatBundleError,
    formatBundleErrors,
    connectMetroBuildEvents,
    disconnectMetroBuildEvents,
    isConnectedToMetroBuildEvents,
    fetchBundleStatus,
    getBundleErrors,
    getBundleStatusWithErrors
} from "./bundle.js";

// Debug HTTP Server
export { startDebugHttpServer, getDebugServerPort } from "./httpServer.js";

// HTTP Server Process (for hot-reload)
export {
    startHttpServerProcess,
    stopHttpServerProcess,
    restartHttpServerProcess,
    getHttpServerProcessPort,
    isHttpServerProcessRunning
} from "./httpServerProcess.js";

// Telemetry
export { initTelemetry, isTelemetryEnabled, trackToolInvocation } from "./telemetry.js";

// OCR
export { recognizeText, terminateOCRWorker, inferIOSDevicePixelRatio } from "./ocr.js";
export type { OCRResult, OCRWord, OCRLine, OCROptions } from "./ocr.js";

// Error Screen Parser (OCR-based bundle error fallback)
export { parseErrorScreenText, formatParsedError } from "./errorScreenParser.js";
export type { ParsedErrorScreen } from "./errorScreenParser.js";

// Format utilities (TONL)
export { formatLogsAsTonl, formatNetworkAsTonl } from "./format.js";
export type { OutputFormat } from "./format.js";
