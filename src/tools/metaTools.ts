/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, unlinkSync } from "fs";

import { registerToolWithTelemetry, toolRegistry } from "../core/register.js";
import { getGuideOverview, getGuideByTopic, getAvailableTopics } from "../core/guides.js";
import { getLicenseStatus, getUsageInfo, getDashboardUrl, requestLinkToken, refreshLicense } from "../core/license.js";
import { refreezeSessionVerdict } from "../pro/usageGate.js";
import { getServerVersion, TELEMETRY_JSONL_PATH } from "../core/telemetry.js";
import { getTargetPlatform } from "../core/state.js";
import { formatIssueBody, buildGitHubUrl } from "../core/feedback.js";

export interface MetaToolOptions {
    devMode: boolean;
    httpMode: boolean;
}

export function registerMetaTools(server: McpServer, opts: MetaToolOptions): void {
    // Tool: Usage guide for agents
    registerToolWithTelemetry(
        server,
        "get_usage_guide",
        {
            description:
                "Get recommended workflows and best practices for using the debugging tools. Call without parameters to see all available topics with short descriptions. Call with a topic parameter to get the full guide for that topic.",
            inputSchema: {
                topic: z
                    .string()
                    .optional()
                    .describe(
                        "Topic to get the full guide for. Available topics: setup, inspect, layout, interact, logs, network, state, bundle, feedback, flowpoints. Omit to see the overview of all topics."
                    )
            }
        },
        async ({ topic }) => {
            if (!topic) {
                return {
                    content: [{ type: "text", text: getGuideOverview() }]
                };
            }

            const guide = getGuideByTopic(topic);
            if (!guide) {
                const available = getAvailableTopics().join(", ");
                return {
                    content: [
                        {
                            type: "text",
                            text: `Unknown topic: "${topic}". Available topics: ${available}`
                        }
                    ],
                    isError: true
                };
            }

            return {
                content: [{ type: "text", text: guide }]
            };
        }
    );

    // Tool: License status
    registerToolWithTelemetry(
        server,
        "get_license_status",
        {
            description:
                "Get your installation ID, license tier, and this month's usage against the free cap. Shows the Installation ID (needed to link Pro in the dashboard), current tier, cache validity, and calls used / remaining this month.",
            inputSchema: {},
        },
        async () => {
            // Re-validate against the server so a mid-session upgrade (e.g. bought
            // on the dashboard) is reflected here, then lift/re-apply the frozen
            // session block accordingly — no MCP restart needed to clear a stale block.
            await refreshLicense();
            refreezeSessionVerdict(getUsageInfo());

            const status = getLicenseStatus();
            const lines: string[] = [];

            lines.push(`Installation ID: ${status.installationId}`);
            lines.push(`License: ${status.tier.charAt(0).toUpperCase() + status.tier.slice(1)}`);

            if (status.plan) {
                const exp = new Date(status.plan.expiresAt);
                const expStr = Number.isNaN(exp.getTime())
                    ? String(status.plan.expiresAt)
                    : exp.toLocaleDateString();
                lines.push(`Plan expires: ${expStr}`);
            }

            lines.push(`Cache valid until: ${status.cacheExpiresAt}`);

            const usage = getUsageInfo();
            if (usage && usage.limit != null) {
                lines.push("");
                lines.push("--- Usage ---");
                lines.push(`Monthly usage: ${usage.used} / ${usage.limit}`);
                lines.push(`Month: ${usage.monthKey}`);
                if (usage.resetsAt) lines.push(`Resets: ${new Date(usage.resetsAt).toLocaleDateString()}`);
                if (usage.capActive === false && usage.enforcementStartsAt) {
                    lines.push(
                        `Status: Grace period — cap applies ${new Date(usage.enforcementStartsAt).toLocaleDateString()}`
                    );
                } else {
                    lines.push(
                        `Status: ${usage.canUse ? "Active" : "Limit reached — upgrade at " + getDashboardUrl() + "/upgrade"}`
                    );
                }
            }

            if (status.tier === "free") {
                const dashboardUrl = getDashboardUrl();
                if (dashboardUrl) {
                    const linkToken = await requestLinkToken();
                    if (linkToken) {
                        lines.push("");
                        lines.push(`Link your account: ${dashboardUrl}/link?token=${linkToken}`);
                    }
                }
            }

            return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
            };
        }
    );

    // Tool: Send feedback / bug report / feature request
    registerToolWithTelemetry(
        server,
        "send_feedback",
        {
            description:
                "Report feedback about the ExecBro MCP tools THEMSELVES — a tool (tap, get_screen_layout, get_logs, etc.) that behaved incorrectly, was confusing, was missing, or could work better. " +
                "This is EXCLUSIVELY about your experience operating ExecBro's debugging tools. It is NOT for bugs in the user's app under test, and NOT for the feature or task you were working on in this session — keep that out of the report entirely. " +
                "Auto-collects environment info. Returns a pre-filled GitHub issue URL and formatted issue body. " +
                "Ask the user to open the URL and paste the body to submit.",
            inputSchema: {
                type: z.enum(["feedback", "feature_request", "bug"]).describe('Type, scoped to ExecBro tooling: "bug" = an ExecBro tool malfunctioned, "feature_request" = a missing ExecBro capability, "feedback" = general notes on using the ExecBro tools'),
                title: z.string().describe("Short summary of the ExecBro tooling issue (becomes the GitHub issue title)"),
                description: z.string().describe("What about ExecBro's tools went wrong or could be better: which tool, what you expected it to do, what it actually did. Do NOT describe the app feature or task you were debugging — only the tool's behavior."),
                workflow_context: z.string().optional().describe("Which ExecBro tools were in use when the issue surfaced (e.g. \"tap → get_screen_layout retry loop\"). Name the tools and the debugging step — not the user's app goal.")
            }
        },
        async ({ type, title, description, workflow_context }) => {
            // Collect environment info
            const serverVersion = getServerVersion();
            const platform = process.platform;
            const deviceType = getTargetPlatform();
            const licenseStatus = getLicenseStatus();

            const env = {
                serverVersion,
                platform,
                deviceType,
                licenseTier: licenseStatus.tier
            };

            const input = { type, title, description, workflowContext: workflow_context };
            const issueBody = formatIssueBody(input, env);
            const githubUrl = buildGitHubUrl(title, type);

            const output = [
                "## Feedback Report Ready",
                "",
                `**GitHub Issue URL:** ${githubUrl}`,
                "",
                "**Issue body to paste:**",
                "",
                "```markdown",
                issueBody,
                "```",
                "",
                "Please ask the user to:",
                "1. Open the GitHub URL above",
                "2. Paste the issue body into the description field",
                "3. Review and submit the issue"
            ].join("\n");

            return {
                content: [{ type: "text" as const, text: output }]
            };
        }
    );

    // Dev-only tool: reset local telemetry data
    if (opts.devMode) {
        registerToolWithTelemetry(
            server,
            "reset_telemetry",
            {
                description:
                    "Clear local telemetry data file (/tmp/rn-devtools-telemetry.jsonl). Only available in development mode.",
                inputSchema: {},
            },
            async () => {
                if (existsSync(TELEMETRY_JSONL_PATH)) {
                    unlinkSync(TELEMETRY_JSONL_PATH);
                    return {
                        content: [{ type: "text" as const, text: "Local telemetry data cleared." }],
                    };
                }
                return {
                    content: [{ type: "text" as const, text: "No local telemetry data file found." }],
                };
            }
        );
    }

    // HTTP-only meta-tool: dev (proxies any tool from the latest in-process registry)
    if (opts.httpMode) {
        server.registerTool(
            "dev",
            {
                description:
                    'Development meta-tool for hot-reload testing. Use action="list" for a compact tool listing (name + first description line); pass filter to narrow by substring or verbose=true for full descriptions. ' +
                    'Use action="call" with tool and args to invoke any tool using the latest code after hot-reload. ' +
                    "This tool always reflects the latest server code without needing a session restart.",
                inputSchema: {
                    action: z.enum(["list", "call"]).describe('"list" to see all tools, "call" to invoke a tool'),
                    tool: z.string().optional().describe("Tool name to call (required when action is call)"),
                    args: z.record(z.any()).optional().describe("Arguments to pass to the tool (optional, default {})"),
                    filter: z.string().optional().describe("list only: case-insensitive substring filter on tool name"),
                    verbose: z.boolean().optional().describe("list only: include full multi-line descriptions (default: first line only)"),
                },
            },
            async ({ action, tool, args, filter, verbose }: { action: "list" | "call"; tool?: string; args?: Record<string, any>; filter?: string; verbose?: boolean }) => {
                if (action === "list") {
                    const needle = filter?.toLowerCase();
                    const tools = Array.from(toolRegistry.entries())
                        .filter(([name]) => !needle || name.toLowerCase().includes(needle))
                        .map(([name, { config }]) => {
                            const full = config.description || "";
                            return {
                                name,
                                description: verbose ? full : full.split("\n")[0],
                            };
                        });
                    return {
                        content: [{ type: "text" as const, text: JSON.stringify(tools, null, 2) }],
                    };
                }

                if (action === "call") {
                    if (!tool) {
                        return {
                            content: [{ type: "text" as const, text: 'Error: "tool" parameter is required when action is "call"' }],
                            isError: true,
                        };
                    }
                    const entry = toolRegistry.get(tool);
                    if (!entry) {
                        return {
                            content: [{ type: "text" as const, text: `Error: Tool "${tool}" not found. Use action="list" to see available tools.` }],
                            isError: true,
                        };
                    }
                    return await entry.handler(args || {});
                }

                return {
                    content: [{ type: "text" as const, text: 'Error: action must be "list" or "call"' }],
                    isError: true,
                };
            }
        );
    }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
