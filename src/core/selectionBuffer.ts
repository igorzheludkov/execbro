export interface SelectionFrame {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ComponentStack {
    component: string;
    stack: string;
}

export interface SelectionEntry {
    id: string;
    device: string;
    timestamp: number;
    element: string;
    path: string;
    hierarchy: string[];
    frame: SelectionFrame | null;
    style: Record<string, unknown> | null;
    /** Raw fiber _debugStack strings, harvested at tap time. Symbolicated lazily on read. */
    stacks: ComponentStack[];
}

function signature(entry: SelectionEntry): string {
    const f = entry.frame;
    const frameSig = f ? `${f.left},${f.top},${f.width},${f.height}` : "none";
    return `${entry.device}|${entry.path}|${frameSig}`;
}

export class SelectionBuffer {
    private entries: SelectionEntry[] = [];
    private maxSize: number;

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
    }

    /**
     * Appends unless it duplicates the most recent entry for the same device.
     * Returns whether the entry was accepted, so the poller can tell a genuine
     * new tap from a re-read of the same selection.
     */
    add(entry: SelectionEntry): boolean {
        const previous = this.latest(entry.device);
        if (previous && signature(previous) === signature(entry)) {
            return false;
        }
        this.entries.push(entry);
        while (this.entries.length > this.maxSize) {
            this.entries.shift();
        }
        return true;
    }

    list(options: { device?: string; limit?: number } = {}): SelectionEntry[] {
        let filtered = this.entries;
        if (options.device) {
            filtered = filtered.filter((e) => e.device === options.device);
        }
        const newestFirst = [...filtered].reverse();
        return options.limit !== undefined ? newestFirst.slice(0, options.limit) : newestFirst;
    }

    latest(device?: string): SelectionEntry | undefined {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (!device || this.entries[i].device === device) return this.entries[i];
        }
        return undefined;
    }

    clear(): void {
        this.entries = [];
    }

    get size(): number {
        return this.entries.length;
    }
}

export const selectionBuffer = new SelectionBuffer(100);
