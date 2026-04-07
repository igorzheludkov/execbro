export interface ImageEntry {
    id: string;
    image: Buffer;
    timestamp: number;
    source: string;
    groupId?: string;
    metadata?: Record<string, any>;
}

export interface ImageGroup {
    groupId: string;
    intent: string;
    source: string;
    timestamp: number;
    frameCount: number;
    summary: Record<string, any>;
}

export type ImageEntryMeta = Omit<ImageEntry, "image">;

export class ImageBuffer {
    private entries: ImageEntry[] = [];
    private groups: Map<string, ImageGroup> = new Map();
    private maxSize: number;

    constructor(maxSize: number = 50) {
        this.maxSize = maxSize;
    }

    add(entry: ImageEntry): void {
        this.entries.push(entry);
        while (this.entries.length > this.maxSize) {
            const evicted = this.entries.shift();
            if (evicted?.groupId) {
                this.cleanupGroupIfEmpty(evicted.groupId);
            }
        }
    }

    addGroup(group: ImageGroup): void {
        this.groups.set(group.groupId, group);
    }

    getById(id: string): ImageEntry | undefined {
        return this.entries.find((e) => e.id === id);
    }

    getByGroupFrame(groupId: string, frameIndex: number): ImageEntry | undefined {
        return this.entries.find(
            (e) => e.groupId === groupId && e.metadata?.frameIndex === frameIndex
        );
    }

    listEntries(options: {
        source?: string;
        groupId?: string;
        last?: number;
    } = {}): ImageEntryMeta[] {
        let filtered = this.entries;

        if (options.source) {
            filtered = filtered.filter((e) => e.source === options.source);
        }

        if (options.groupId) {
            filtered = filtered.filter((e) => e.groupId === options.groupId);
        }

        if (options.last && options.last > 0) {
            filtered = filtered.slice(-options.last);
        }

        return filtered.map(({ image, ...meta }) => meta);
    }

    listGroups(): ImageGroup[] {
        return Array.from(this.groups.values());
    }

    clear(): number {
        const count = this.entries.length;
        this.entries = [];
        this.groups.clear();
        return count;
    }

    get size(): number {
        return this.entries.length;
    }

    private cleanupGroupIfEmpty(groupId: string): void {
        const hasEntries = this.entries.some((e) => e.groupId === groupId);
        if (!hasEntries) {
            this.groups.delete(groupId);
        }
    }
}
