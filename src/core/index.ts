// Types
export * from "./types.js";

// State
export { logBuffer, networkBuffer, bundleErrorBuffer, connectedApps, pendingExecutions, getNextMessageId } from "./state.js";

// Logs
export { LogBuffer, mapConsoleType, formatLogs, getLogs, searchLogs } from "./logs.js";

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
    discoverMetroDevices
} from "./metro.js";

// Connection
export {
    formatRemoteObject,
    handleCDPMessage,
    connectToDevice,
    getConnectedApps,
    getFirstConnectedApp,
    hasConnectedApp
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
    androidGetScreenSize
} from "./android.js";

// iOS (simctl + IDB)
export {
    // simctl-based tools
    isSimctlAvailable,
    listIOSSimulators,
    getBootedSimulatorUdid,
    iosScreenshot,
    iosInstallApp,
    iosLaunchApp,
    iosOpenUrl,
    iosTerminateApp,
    iosBootSimulator,
    // IDB-based UI tools
    isIdbAvailable,
    iosTap,
    iosSwipe,
    iosInputText,
    iosButton,
    iosKeyEvent,
    iosKeySequence,
    iosDescribeAll,
    iosDescribePoint,
    IOS_BUTTON_TYPES
} from "./ios.js";

// iOS types
export type { iOSButtonType, iOSAccessibilityElement, iOSDescribeResult } from "./ios.js";

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
