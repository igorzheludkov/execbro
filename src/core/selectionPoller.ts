import { executeInApp } from "./jsExecute.js";
import {
    buildSelectionProbeExpression,
    buildDebugStackHarvestExpression,
} from "./componentSource.js";
import type { ProbeResult, RawComponentStack } from "./componentSource.js";
import { selectionBuffer } from "./selectionBuffer.js";

export const IDLE_INTERVAL_MS = 2000;
export const ACTIVE_INTERVAL_MS = 500;

const timers = new Map<string, NodeJS.Timeout>();
let entryCounter = 0;

function pollingDisabled(): boolean {
    return process.env.EXECBRO_DISABLE_SELECTION_POLL === "1";
}

/**
 * One poll cycle. The probe is cheap and runs every tick; the harvest measures
 * host fibers and runs only when the probe reports a change - once per tap.
 * Returns whether an entry was buffered.
 */
export async function pollOnce(device: string): Promise<boolean> {
    let probe: ProbeResult;
    try {
        const raw = await executeInApp(
            buildSelectionProbeExpression(),
            false,
            {
                maxRetries: 0,
                autoReconnect: false,
                timeoutMs: 3000,
                originatingToolName: "selection_poll",
            },
            device
        );
        if (!raw.success || !raw.result) return false;
        probe = JSON.parse(raw.result) as ProbeResult;
    } catch {
        return false;
    }

    if (!probe.changed || !probe.selected) return false;

    let stacks: RawComponentStack[] = [];
    if (probe.frame) {
        const centreX = probe.frame.left + probe.frame.width / 2;
        const centreY = probe.frame.top + probe.frame.height / 2;
        try {
            const harvest = await executeInApp(
                buildDebugStackHarvestExpression(centreX, centreY),
                true,
                {
                    maxRetries: 0,
                    autoReconnect: false,
                    timeoutMs: 3000,
                    originatingToolName: "selection_poll",
                },
                device
            );
            if (harvest.success && harvest.result) {
                const parsed = JSON.parse(harvest.result) as { stacks?: RawComponentStack[] };
                stacks = parsed.stacks ?? [];
            }
        } catch {
            stacks = [];
        }
    }

    entryCounter += 1;
    return selectionBuffer.add({
        id: `sel-${Date.now()}-${entryCounter}`,
        device,
        timestamp: Date.now(),
        element: probe.element ?? "Unknown",
        path: probe.path ?? "",
        hierarchy: probe.hierarchy ?? [],
        frame: probe.frame ?? null,
        style: probe.style ?? null,
        stacks,
    });
}

export function isSelectionPollerRunning(device: string): boolean {
    return timers.has(device);
}

export function startSelectionPoller(device: string): void {
    if (pollingDisabled() || timers.has(device)) return;

    const schedule = (delay: number): void => {
        const timer = setTimeout(async () => {
            let active = false;
            try {
                active = await pollOnce(device);
            } catch {
                active = false;
            }
            if (timers.has(device)) {
                schedule(active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
            }
        }, delay);
        timer.unref?.();
        timers.set(device, timer);
    };

    schedule(IDLE_INTERVAL_MS);
}

export function stopSelectionPoller(device: string): void {
    const timer = timers.get(device);
    if (timer) clearTimeout(timer);
    timers.delete(device);
}

export function stopAllSelectionPollers(): void {
    for (const device of [...timers.keys()]) {
        stopSelectionPoller(device);
    }
}
