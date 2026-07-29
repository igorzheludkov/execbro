import { LEVEL_RANK, type DraftEvent, type EventLevel } from "./logEvents.js";

/** Kinds that are always worth a row, whatever their level. */
const ALWAYS: ReadonlySet<string> = new Set(["crash", "anr"]);

/**
 * Gate 2: is this event worth a row?
 *
 * Runs AFTER grouping, because it tests `kind` and only the grouper assigns
 * that. The exemption matters: a backtrace's continuation lines carry no
 * marker identifying them as part of a crash, so a floor applied to lines
 * would shred exactly the events this feature exists to surface.
 */
export function isRelevant(
    event: Pick<DraftEvent, "level" | "kind">,
    opts: { minLevel: EventLevel }
): boolean {
    if (ALWAYS.has(event.kind)) return true;
    return LEVEL_RANK[event.level] >= LEVEL_RANK[opts.minLevel];
}
