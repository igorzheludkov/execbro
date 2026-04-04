import { PostHog } from "posthog-node";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const apiKey = "phc_snUX9TpjAwNhosPMxAY7D89ijESyrQzucAi9qbPJptPY";
const host = "https://us.i.posthog.com";

let _client: PostHog | null = null;
let _identified = false;

export function getPostHogClient(): PostHog | null {
    if (!_client) {
        _client = new PostHog(apiKey, {
            host,
            enableExceptionAutocapture: true,
        });
    }
    return _client;
}

export function identifyIfDevMode(distinctId: string): void {
    if (_identified) return;
    _identified = true;
    try {
        const configPath = join(homedir(), ".rn-ai-debugger", "telemetry.json");
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
