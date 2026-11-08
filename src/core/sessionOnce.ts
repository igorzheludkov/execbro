/**
 * Lines that repeat on every call (fixed advice, the default-device note) inform once
 * and then only cost context. Shown the first time per slot and again whenever their
 * value changes. Per server process: in HTTP dev mode clients share it, which is fine.
 */
const shown = new Map<string, string>();

export function changedSinceLastShown(slot: string, value: string): boolean {
    if (shown.get(slot) === value) return false;
    shown.set(slot, value);
    return true;
}

export function resetSessionOnce(): void {
    shown.clear();
}
