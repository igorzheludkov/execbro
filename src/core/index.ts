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
export {
  logBuffers,
  networkBuffers,
  getLogBuffer,
  getNetworkBuffer,
  getAllLogs,
  getTotalLogCount,
  bundleErrorBuffer,
  imageBuffer,
  connectedApps,
  pendingExecutions,
  getNextMessageId,
  getActiveSimulatorUdid,
  getLastCDPMessageTime,
  updateLastCDPMessageTime,
  clearLastCDPMessageTime,
  clearAllCDPMessageTimes,
  getTargetPlatform,
} from "./state.js";

// Logs
export {
  LogBuffer,
  mapConsoleType,
  formatLogs,
  getLogs,
  searchLogs,
  getLogSummary,
} from "./logs.js";

// Image Buffer
export { ImageBuffer } from "./imageBuffer.js";
export type { ImageEntry, ImageGroup, ImageEntryMeta } from "./imageBuffer.js";

// Network
export {
  NetworkBuffer,
  formatRequest,
  formatRequests,
  formatRequestDetails,
  getNetworkRequests,
  searchNetworkRequests,
  getNetworkStats,
} from "./network.js";

// Metro
export {
  COMMON_PORTS,
  isPortOpen,
  scanMetroPorts,
  fetchDevices,
  selectMainDevice,
  filterBridgelessDevices,
  filterDebuggableDevices,
  discoverMetroDevices,
  checkMetroState,
} from "./metro.js";

export type { MetroState } from "./metro.js";

// Connection
export {
  formatRemoteObject,
  handleCDPMessage,
  connectToDevice,
  getConnectedApps,
  getFirstConnectedApp,
  getConnectedAppByDevice,
  hasConnectedApp,
  runQuickHealthCheck,
  ensureConnection,
  getPassiveConnectionStatus,
  checkAndEnsureConnection,
  suppressReconnection,
  suppressReconnectionForKey,
  clearReconnectionSuppression,
  purgeStaleConnectionsForPorts,
  verifyLogPipeline,
  isHealthCheckMarker,
} from "./connection.js";

export type {
  PassiveConnectionStatus,
  LogPipelineResult,
} from "./connection.js";

// Executor
export {
  executeInApp,
  listDebugGlobals,
  inspectGlobal,
  reloadApp,
  // React Component Inspection
  getComponentTree,
  getScreenLayout,
  getPressableElements,
  enrichScreenshotWithLayout,
  inspectComponent,
  findComponents,
  pressElement,
  // Coordinate-based inspection
  inspectAtPoint,
  toggleElementInspector,
  isInspectorActive,
  getInspectorSelection,
} from "./executor.js";

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
  androidWaitForElement,
} from "./android.js";

// Android types
export type {
  AndroidAccessibilityElement,
  AndroidDescribeResult,
  AndroidUIElement,
  FindElementResult,
  WaitForElementResult,
  FindElementOptions,
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
  // UI driver tools (IDB or AXe)
  isIdbAvailable,
  isAxeAvailable,
  isUiDriverAvailable,
  getUiDriverInstallHint,
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
  iosWaitForElement,
} from "./ios.js";

// iOS types
export type {
  iOSButtonType,
  iOSAccessibilityElement,
  iOSDescribeResult,
  IOSUIElement,
  IOSFindElementResult,
  IOSWaitForElementResult,
  IOSFindElementOptions,
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
  getBundleStatusWithErrors,
} from "./bundle.js";

// License & Usage
export {
  ensureLicense,
  getLicenseStatus,
  getUsageInfo,
  incrementLocalUsage,
} from "./license.js";
export type { LicenseTier, LicenseStatus, UsageInfo } from "./license.js";

// Telemetry
export {
  initTelemetry,
  isTelemetryEnabled,
  trackToolInvocation,
} from "./telemetry.js";

// OCR
export {
  recognizeText,
  terminateOCRWorker,
  inferIOSDevicePixelRatio,
} from "./ocr.js";
export type { OCRResult, OCRWord, OCRLine, OCROptions } from "./ocr.js";

// Error Screen Parser (OCR-based bundle error fallback)
export {
  parseErrorScreenText,
  formatParsedError,
} from "./errorScreenParser.js";
export type { ParsedErrorScreen } from "./errorScreenParser.js";

// LogBox detection & dismissal
export {
  detectLogBox,
  dismissLogBox,
  formatLogBoxWarning,
  formatDismissedEntries,
  pushLogBox,
  addLogBoxIgnorePatterns,
  notifyDriverMissing,
  getLastLogBoxError,
} from "./logbox.js";
export type {
  LogBoxState,
  LogBoxEntry,
  LogBoxDismissResult,
} from "./logbox.js";

// Feedback
export {
  shouldShowFeedbackHint,
  markFeedbackHintShown,
  formatIssueBody,
  buildGitHubUrl,
} from "./feedback.js";

// Format utilities (TONL)
export { formatLogsAsTonl, formatNetworkAsTonl } from "./format.js";
export type { OutputFormat } from "./format.js";
