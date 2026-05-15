import { PostHog } from "posthog-node";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./paths.js";

const apiKey = "phc_snUX9TpjAwNhosPMxAY7D89ijESyrQzucAi9qbPJptPY";
const host = "https://us.i.posthog.com";

let _client: PostHog | null = null;
let _identified = false;

export function getPostHogClient(): PostHog | null {
    if (!_client) {
        _client = new PostHog(apiKey, {
            host,
            // H1 (Step 9): autocapture installs a global uncaughtException
            // handler that ships every throw to PostHog — including the SDK's
            // own EPIPE on a dying socket, producing 100s of self-referential
            // events per crash (~83% of error-tracking volume). We capture
            // tool errors explicitly at index.ts already, so autocapture is a
            // redundant safety net that misfires on its own plumbing.
            enableExceptionAutocapture: false,
        });
    }
    return _client;
}

export function identifyIfDevMode(distinctId: string): void {
    if (_identified) return;
    _identified = true;
    try {
        const configPath = join(CONFIG_DIR, "telemetry.json");
        if (existsSync(configPath)) {
            const data = JSON.parse(readFileSync(configPath, "utf-8"));
            if (data.internal) {
                getPostHogClient()?.identify({
                    distinctId,
                    properties: {
                        $set: { $internal_or_test_user: true },
                    },
                });
            }
        }
    } catch {
        // Config unreadable — skip
    }
}

export async function shutdownPostHog(): Promise<void> {
    if (_client) {
        await _client.shutdown();
        _client = null;
    }
}
