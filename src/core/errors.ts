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
    /**
     * Optional low-cardinality tag (e.g. "device_mismatch") forwarded to
     * telemetry's error-context column. Lets the dashboard cluster validation
     * failures by cause instead of regex-matching free-form messages.
     */
    readonly context?: string;

    /**
     * Optional structured cause, same closed set as `EnvironmentError.kind`.
     * Some device-resolution failures are genuinely environment states
     * (nothing attached) while others are agent mistakes (wrong name), and
     * both throw from the same site — so the kind rides along here rather
     * than forcing a class split that would change which failures reach
     * error tracking.
     */
    readonly kind?: FailureKind;

    constructor(message: string, context?: string, kind?: FailureKind) {
        super(message);
        this.name = "UserInputError";
        this.context = context;
        this.kind = kind;
    }
}

/**
 * Machine-readable cause of a failure, set where the error is constructed
 * rather than inferred from message text later.
 *
 * Why not reuse `errorContext` (blob8), which is already documented as a
 * "short, low-cardinality failure tag": it is only sometimes that. Several
 * sites pass free-form prose through it — `executionTools.ts` forwards the raw
 * JS expression, `tap.ts` forwards the predicate — so it cannot be used as a
 * classification key without regex-matching it, which is the exact problem
 * this field exists to remove.
 *
 * See docs `devtools-core/specs/2026-07-31-structured-failure-kind-design.md`.
 * Values are one-to-one with the numbered families in
 * `telemetry/environment-failures.md`, so a row's kind can be checked against
 * its message during the overlap period.
 */
export type FailureKind =
    | "no_devices_attached"
    | "no_apps_connected"
    | "no_metro"
    | "driver_not_installed"
    | "no_debuggable_devices"
    | "devtools_hook_missing"
    | "no_metro_server"
    | "ws_closed"
    | "no_android_device"
    | "no_ios_simulator"
    | "no_fiber_roots"
    | "platform_mismatch"
    | "fiber_guard_unexpected";

/**
 * The kinds that mean "the tool could not have succeeded because the setup was
 * not ready". Deliberately excludes `platform_mismatch` (devices were attached,
 * the agent asked for the wrong one) and `fiber_guard_unexpected` (a defect
 * wearing an environment-shaped message).
 */
export const ENVIRONMENT_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
    "no_devices_attached",
    "no_apps_connected",
    "no_metro",
    "driver_not_installed",
    "no_debuggable_devices",
    "devtools_hook_missing",
    "no_metro_server",
    "ws_closed",
    "no_android_device",
    "no_ios_simulator",
    "no_fiber_roots",
]);

/**
 * Thrown counterpart of the `failureKind` result field, for the sites that
 * throw rather than return a result object. Not a `UserInputError`: these are
 * setup states, not agent mistakes, so they must stay in error tracking.
 */
export class EnvironmentError extends Error {
    readonly kind: FailureKind;

    constructor(message: string, kind: FailureKind) {
        super(message);
        this.name = "EnvironmentError";
        this.kind = kind;
    }
}
