/**
 * Marker class for errors caused by invalid agent input (wrong device name,
 * missing required predicate, ambiguous match, etc). H2 (Step 9 in the
 * 2026-05-15 plan): the top-level catch in index.ts skips PostHog
 * captureException for these so error tracking surfaces real product bugs,
 * not validation noise (~13% of recent dashboard volume).
 *
 * The trade-off vs regex-matching the message: this is self-documenting at
 * the throw site and survives message reformatting / translation.
 */
export class UserInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UserInputError";
    }
}
