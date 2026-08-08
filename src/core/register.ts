import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPostHogClient } from "./posthog.js";
import {
    getInstallationId,
    getServerVersion,
    getPackageName,
    categorizeError,
    trackToolInvocation,
    isTelemetryEnabled,
} from "./telemetry.js";
import { getTargetPlatform } from "./state.js";
import { recordToolCall } from "./screenStaleness.js";
import { UserInputError } from "./errors.js";
import { estimateImageTokens } from "./toolHelpers.js";
import { connectedApps, shouldShowFeedbackHint, markFeedbackHintShown, pushLogBox } from "./index.js";
import { ensureLicense, getUsageInfo } from "./license.js";
import { freezeSessionVerdict, isToolBlocked, usageWarningLine } from "../pro/usageGate.js";
import { maybeNotifyUsage, maybeNotifyDeferral } from "../pro/usageNotifications.js";

// Tools that do NOT require an active Metro connection — excluded from feedback hint trigger
const NON_METRO_TOOLS = new Set([
    "scan_metro",
    "connect_metro",
    "disconnect_metro",
    "ensure_connection",
    "get_connection_status",
    "get_license_status",
    "activate_license",
    "delete_account",
    "get_usage_guide",
    "get_apps",
    "list_devices",
    "ios_boot_simulator",
    "ios_launch_app",
    "android_launch_app",
    "send_feedback"
]);

// Registry for dev meta-tool — stores handlers and configs for dynamic dispatch.
// Also exported so unit tests can enumerate every registered tool without booting
// the server. Populated by registerToolWithTelemetry AND by the server.registerTool
// interceptor installed below, so it captures every registration site.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const toolRegistry = new Map<string, { config: any; handler: (args: any) => Promise<any> }>();

// Interceptor: capture every direct server.registerTool call into toolRegistry so
// tests and the dev meta-tool see the full surface (including platform-native tools
// and the dev meta-tool itself that bypass registerToolWithTelemetry).
export function installToolRegistryInterceptor(server: McpServer): void {
    const _originalRegisterTool = server.registerTool.bind(server);
    (server as any).registerTool = (name: string, config: any, handler: any) => {
        toolRegistry.set(name, { config, handler });
        return _originalRegisterTool(name, config, handler);
    };
}

export function registerToolWithTelemetry(
    server: McpServer,
    toolName: string,
    config: any,
    handler: (args: any) => Promise<any>,
    emptyResultDetector?: (result: any) => boolean,
): void {
    toolRegistry.set(toolName, { config, handler });
    server.registerTool(toolName, config, async (args: any) => {
        // Resolve + freeze the session verdict once (session-start semantics),
        // then gate. Cap logic lives in src/pro/ (commercial); this MIT wrapper
        // only calls into it.
        await ensureLicense();
        freezeSessionVerdict(getUsageInfo());
        const usageNow = getUsageInfo();
        void maybeNotifyDeferral(usageNow);
        void maybeNotifyUsage(usageNow);
        const gate = isToolBlocked(toolName);
        if (gate.blocked) {
            return { content: [{ type: "text" as const, text: gate.message! }] };
        }
        const startTime = Date.now();
        let success = true;
        let errorMessage: string | undefined;
        let errorContext: string | undefined;
        // Which of the two failure paths ran. Both set success=false and share the
        // trackToolInvocation call below, so without this the dashboard cannot tell
        // a handled { isError: true } return from a real thrown exception — and only
        // the latter produces a stack trace or reaches captureException.
        let errorOrigin: "thrown" | "returned" | undefined;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let emptyResult: boolean | undefined;
        let meaningful: boolean | undefined;
        let changeRate: number | undefined;
        let tapStrategy: string | undefined;
        let iosDriver: string | undefined;
        let responsePreview: string | undefined;
        let emptyReason: string | undefined;
        let artifactKey: string | undefined;
        let ocrClosestMatch: string | undefined;
        let fiberPressableCount: string | undefined;
        let accessibilityMatchCount: string | undefined;
        let appRoute: string | undefined;

        try {
            inputTokens = Math.ceil(JSON.stringify(args).length / 4);
        } catch {
            /* circular refs — leave undefined */
        }

        try {
            const result = await handler(args);
            // Check if result indicates an error
            if (result?.isError) {
                success = false;
                errorOrigin = "returned";
                // Prefer concise _errorMessage over full response text (which may be large JSON)
                errorMessage = result._errorMessage || result.content?.[0]?.text || "Unknown error";
            }
            // Always propagate _errorContext when the tool provides it (e.g. tap predicate
            // for unmeaningful outcomes where isError is false but we still want triage context).
            if (result?._errorContext) {
                errorContext = result._errorContext;
            }
            // Check for empty result (only on success). A tool that reports
            // `_emptyResult` wins over the detector: the detector can only see
            // global state, while the handler knows what it actually returned
            // to the caller. Mixing the two produced both false empties (SDK
            // path served logs while the CDP buffer was empty) and false
            // non-empties (device/level filter matched nothing while another
            // buffer held logs), which made the empty rate unreadable.
            if (success) {
                if (typeof result?._emptyResult === "boolean") {
                    emptyResult = result._emptyResult;
                } else if (emptyResultDetector) {
                    try {
                        emptyResult = emptyResultDetector(result);
                    } catch {
                        // Detector failure should never affect tool execution
                    }
                }
            }
            // Extract meaningfulness data if provided (tap tool verification)
            if (result?._meaningful !== undefined) meaningful = result._meaningful;
            if (result?._changeRate !== undefined) changeRate = result._changeRate;
            if (result?._tapStrategy) tapStrategy = result._tapStrategy;
            if (result?._iosDriver) iosDriver = result._iosDriver;
            if (result?._emptyReason) emptyReason = result._emptyReason;
            if (result?._artifactKey) artifactKey = result._artifactKey;
            if (result?._ocrClosestMatch) ocrClosestMatch = result._ocrClosestMatch;
            if (result?._fiberPressableCount) fiberPressableCount = result._fiberPressableCount;
            if (result?._accessibilityMatchCount) accessibilityMatchCount = result._accessibilityMatchCount;
            if (result?._appRoute) appRoute = result._appRoute;
            if (Array.isArray(result?.content)) {
                let totalTokens = 0;
                for (const item of result.content) {
                    if (item.type === "text" && typeof item.text === "string") {
                        totalTokens += Math.ceil(item.text.length / 4);
                    } else if (item.type === "image" && typeof item.data === "string") {
                        totalTokens += estimateImageTokens(item.data);
                    }
                }
                if (totalTokens > 0) outputTokens = totalTokens;
            }
            // Capture response text preview for local dev dashboard
            if (Array.isArray(result?.content)) {
                const textParts = result.content
                    .filter((item: { type: string }) => item.type === "text")
                    .map((item: { text: string }) => item.text);
                if (textParts.length > 0) {
                    responsePreview = textParts.join("\n").substring(0, 2000);
                }
            }
            // First-install feedback hint — fires once on first successful Metro-connected tool
            if (!NON_METRO_TOOLS.has(toolName) && shouldShowFeedbackHint()) {
                markFeedbackHintShown();
                // Fire-and-forget — don't block the tool response
                pushLogBox(
                    "Congratulations on your first tool call! If you encounter any issues or have ideas for improvement, ask your AI assistant to call send_feedback. Your feedback helps me make this product better for everyone. Best regards, ExecBro developer.",
                    "warning",
                    true,
                    "logbox"
                ).catch(() => {
                    // Non-fatal — hint delivery failure should not affect tool execution
                });
            }
            const warn = usageWarningLine(getUsageInfo());
            if (warn && Array.isArray(result?.content)) {
                result.content.push({ type: "text" as const, text: warn });
            }
            return result;
        } catch (error) {
            success = false;
            errorOrigin = "thrown";
            errorMessage = error instanceof Error ? error.message : String(error);
            // Thrown validation errors can carry a triage tag; without this the
            // error-context column is empty for every throwing tool path.
            if (error instanceof UserInputError && error.context) {
                errorContext = error.context;
            }
            // H2 (Step 9): UserInputError marks agent-input mistakes (unknown
            // device, missing predicate, ambiguous match). They flow through
            // telemetry's trackToolInvocation in the finally block; we just
            // skip the dedicated error-tracking pipe so the dashboard surfaces
            // real product bugs rather than validation noise.
            if (!(error instanceof UserInputError) && isTelemetryEnabled()) {
                getPostHogClient()?.captureException(error, getInstallationId(), { tool: toolName, server_version: getServerVersion(), package_name: getPackageName() });
            }
            throw error;
        } finally {
            const duration = Date.now() - startTime;
            // Attribute the NEXT tool's screen changes. Recorded here, in
            // `finally`, so that while a handler runs this still names the
            // PREVIOUS tool — which is what screenStaleness needs to tell
            // "the agent moved the screen" from "someone else did".
            recordToolCall(toolName);
            trackToolInvocation(toolName, success, duration, errorMessage, errorContext, inputTokens, outputTokens, getTargetPlatform(), emptyResult, meaningful, changeRate, tapStrategy, iosDriver, responsePreview, emptyReason, artifactKey, ocrClosestMatch, fiberPressableCount, accessibilityMatchCount, appRoute, errorOrigin);
            // Classify this invocation's platform kind so PostHog breakdowns can split RN vs Native.
            // RN: any connected app has appDetection. Native: tool name prefixed ios_/android_. Else: null.
            let platformKind: "rn" | "native" | null = null;
            for (const app of connectedApps.values()) {
                if (app.appDetection) { platformKind = "rn"; break; }
            }
            if (!platformKind) {
                if (toolName.startsWith("ios_") || toolName.startsWith("android_")) platformKind = "native";
            }

            // Analytics only — gated on the same flag as the tool_invocation
            // mirror in telemetry.ts. Leaving it ungated made opted-out installs
            // emit per-tool events with no tool_invocation/app_detected
            // counterpart, which read as "users who never connected an app".
            // Guarded with an if, never an early return: a `return` inside
            // `finally` discards the exception the catch block re-threw.
            if (isTelemetryEnabled()) {
                getPostHogClient()?.capture({
                    distinctId: getInstallationId(),
                    event: toolName,
                    properties: {
                        success,
                        duration,
                        server_version: getServerVersion(),
                        package_name: getPackageName(),
                        ...(errorMessage && { error: errorMessage.substring(0, 200) }),
                        ...(errorMessage && { error_category: categorizeError(errorMessage, errorContext) }),
                        ...(errorOrigin && { error_origin: errorOrigin }),
                        ...(getTargetPlatform() && { platform: getTargetPlatform() }),
                        ...(platformKind && { platform_kind: platformKind }),
                        ...(tapStrategy && { tap_strategy: tapStrategy }),
                        ...(meaningful !== undefined && { meaningful }),
                        ...(changeRate !== undefined && { change_rate: changeRate }),
                        ...(iosDriver && { ios_driver: iosDriver }),
                        ...(emptyResult !== undefined && { empty_result: emptyResult }),
                        ...(emptyReason && { empty_reason: emptyReason }),
                    },
                });
            }
        }
    });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
