/**
 * Route changes on chromium targets, fed by CDP Page navigation events.
 *
 * A leaf module on purpose: handleCDPMessage records here synchronously, and
 * routeHistory.ts is unreachable from connection.ts without the import cycle
 * through jsExecute. Kept node-side, so reading it never evaluates in a page
 * that a JavaScript dialog may have paused.
 */

export interface ChromiumNavigation {
    route: string;
    at: number;
    epoch: number;
}

const CAP = 200;
const navigations = new Map<string, ChromiumNavigation[]>();

/** The page's route as get_screen_state names it: path plus hash. */
export function routeNameOf(url: string): string | null {
    try {
        const u = new URL(url);
        return u.protocol === "data:" ? "(data: URL)" : u.pathname + u.hash;
    } catch {
        return null;
    }
}

export function recordChromiumNavigation(deviceName: string, url: string, epoch: number, at: number): void {
    const route = routeNameOf(url);
    if (!route) return;
    const list = navigations.get(deviceName) ?? [];
    const last = list[list.length - 1];
    if (last && last.route === route && last.epoch === epoch) return;
    list.push({ route, at, epoch });
    if (list.length > CAP) list.shift();
    navigations.set(deviceName, list);
}

export function chromiumNavigations(deviceName: string): ChromiumNavigation[] {
    return navigations.get(deviceName) ?? [];
}

export function resetChromiumNavigations(): void {
    navigations.clear();
}
