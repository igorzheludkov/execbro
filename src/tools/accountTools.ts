import { z } from "zod";
import { getInstallationId } from "../core/telemetry.js";
import { getDeviceFingerprint } from "../core/fingerprint.js";
import { resetLicense, getDashboardUrl, ensureLicense } from "../core/license.js";
import { existsSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const API_URL = "https://mobile-ai-devtools.link";
const API_KEY = "fb4b5d8f410ff8d0dfe3ade01adc0b2444479ac9380b3f256554dd9d7044f5d2";
const API_TIMEOUT_MS = 10_000;

const CONFIG_DIR = join(homedir(), ".rn-ai-debugger");
const TELEMETRY_FILE = join(CONFIG_DIR, "telemetry.json");
const LICENSE_FILE = join(CONFIG_DIR, "license.json");

export function getActivateLicenseConfig() {
    return {
        description:
            "Activate a Pro license using an activation token from your dashboard. " +
            "Use this if you signed up on the website and need to link your account to this MCP installation.",
        inputSchema: {
            token: z.string().describe("Activation token from your dashboard"),
        },
    };
}

export async function handleActivateLicense({ token }: { token: string }) {
    if (!API_URL) {
        return {
            content: [{ type: "text" as const, text: "License activation is not configured yet." }],
            isError: true,
        };
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        const response = await fetch(`${API_URL}/api/accounts/activate`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": API_KEY,
            },
            body: JSON.stringify({
                installationId: getInstallationId(),
                fingerprint: getDeviceFingerprint(),
                token,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);
        const data = await response.json();

        if (response.ok) {
            resetLicense();
            await ensureLicense();
            return {
                content: [{
                    type: "text" as const,
                    text: `License activated. You're now on the ${data.tier === "pro" ? "Pro" : data.tier} plan.`,
                }],
            };
        }

        if (data.error === "invalid_token") {
            const dashboardUrl = getDashboardUrl();
            return {
                content: [{
                    type: "text" as const,
                    text: `Invalid or expired token. Generate a new one from your dashboard${dashboardUrl ? ` at ${dashboardUrl}` : ""}.`,
                }],
                isError: true,
            };
        }

        if (data.error === "fingerprint_mismatch") {
            return {
                content: [{ type: "text" as const, text: "Activation failed. This token cannot be used on this device." }],
                isError: true,
            };
        }

        if (data.error === "installation_not_found") {
            return {
                content: [{ type: "text" as const, text: "Installation not found. Please restart your MCP server and try again." }],
                isError: true,
            };
        }

        return {
            content: [{ type: "text" as const, text: `Activation failed: ${data.error || "unknown error"}` }],
            isError: true,
        };
    } catch {
        return {
            content: [{ type: "text" as const, text: "Activation failed due to a network error. Please try again." }],
            isError: true,
        };
    }
}

export function getDeleteAccountConfig() {
    return {
        description:
            "Permanently delete your account and reset this MCP installation. " +
            "Removes your server-side data and local cache. You will get a new installation ID on next restart. " +
            "Requires confirm: 'DELETE' to proceed.",
        inputSchema: {
            confirm: z
                .string()
                .optional()
                .describe("Must be exactly 'DELETE' to confirm account deletion"),
        },
    };
}

export async function handleDeleteAccount({ confirm }: { confirm?: string }) {
    if (confirm !== "DELETE") {
        return {
            content: [{
                type: "text" as const,
                text:
                    "This will permanently delete your account and all associated data.\n" +
                    "Your installation ID, license, and any linked account data will be removed.\n" +
                    "Local cache files will be cleared. You will get a new installation ID on next restart.\n\n" +
                    "To confirm, call: delete_account({ confirm: 'DELETE' })",
            }],
        };
    }

    if (!API_URL) {
        cleanupLocalFiles();
        return {
            content: [{
                type: "text" as const,
                text: "Local data cleared. You will get a new installation ID on next MCP server restart.",
            }],
        };
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        const response = await fetch(`${API_URL}/api/accounts/delete`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-API-Key": API_KEY,
            },
            body: JSON.stringify({
                installationId: getInstallationId(),
                fingerprint: getDeviceFingerprint(),
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);
        cleanupLocalFiles();

        if (response.ok || response.status === 404) {
            return {
                content: [{
                    type: "text" as const,
                    text: "Account deleted. You will get a new installation ID on next MCP server restart.",
                }],
            };
        }

        const data = await response.json();
        if (data.error === "fingerprint_mismatch") {
            return {
                content: [{
                    type: "text" as const,
                    text: "Deletion failed: fingerprint mismatch. Local files have been cleared.",
                }],
                isError: true,
            };
        }

        return {
            content: [{ type: "text" as const, text: "Account deletion may not have completed on the server. Local files have been cleared." }],
        };
    } catch {
        cleanupLocalFiles();
        return {
            content: [{
                type: "text" as const,
                text: "Could not reach the server. Local data has been cleared. Server-side data may still exist.",
            }],
        };
    }
}

function cleanupLocalFiles(): void {
    try {
        if (existsSync(LICENSE_FILE)) unlinkSync(LICENSE_FILE);
    } catch { /* best-effort */ }
    try {
        if (existsSync(TELEMETRY_FILE)) unlinkSync(TELEMETRY_FILE);
    } catch { /* best-effort */ }
}
