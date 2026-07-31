/**
 * Registry of in-app promise slots whose poll budget expired.
 *
 * executeWithManualAwait attaches a .then() that pushes the resolved value into
 * a temp global, then polls that slot at 100/300/600/1000/2000/3000 ms — a ~7 s
 * budget. On expiry it used to delete the slot and report a timeout, throwing
 * away a value that had very likely settled a moment later. That is 143 of the
 * 331 production timeout failures (43%), and 7% of every execute_in_app
 * failure: uploads, slow queries and rate-limited requests, all unrecoverable.
 *
 * Retaining the slot turns "lost" into "collectable".
 */
const handlesByDevice: Map<string, Set<string>> = new Map();
const deviceBySlot: Map<string, string> = new Map();

export function registerHandle(deviceKey: string, slotId: string): void {
    let set = handlesByDevice.get(deviceKey);
    if (!set) {
        set = new Set();
        handlesByDevice.set(deviceKey, set);
    }
    set.add(slotId);
    deviceBySlot.set(slotId, deviceKey);
}

export function listHandles(deviceKey: string): string[] {
    return Array.from(handlesByDevice.get(deviceKey) ?? []);
}

export function dropHandle(slotId: string): void {
    const deviceKey = deviceBySlot.get(slotId);
    if (deviceKey) {
        handlesByDevice.get(deviceKey)?.delete(slotId);
        deviceBySlot.delete(slotId);
    }
}

/**
 * A new JS runtime wipes every slot, so retaining handles across a reload would
 * hand out ids that can never resolve. Called from the same places that reset
 * per-run state.
 */
export function clearHandlesForDevice(deviceKey: string): void {
    const set = handlesByDevice.get(deviceKey);
    if (!set) return;
    for (const slotId of set) deviceBySlot.delete(slotId);
    handlesByDevice.delete(deviceKey);
}

/**
 * ES5 source that reads a slot, clearing it only once settled.
 *
 * Pending must not delete: the caller is expected to retry, and deleting here
 * would recreate the bug this module exists to fix. A missing slot is reported
 * distinctly from a pending one so the caller can tell "retry" from "the app
 * reloaded and it is gone".
 */
export function buildCollectExpression(slotId: string): string {
    return `(function(){var s=globalThis['${slotId}'];if(!s)return '__missing__';if(s.s==='pending')return '__pending__';delete globalThis['${slotId}'];return {status:s.s,value:s.v}})()`;
}
