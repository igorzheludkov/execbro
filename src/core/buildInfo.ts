/**
 * Build identity — is this process running from a published npm artifact or
 * from a source checkout?
 *
 * Lives in its own module (rather than inside telemetry.ts) so the token can be
 * read by the transport gate in index.ts without pulling the telemetry module,
 * its disk config, and its network paths into that decision. It is also a much
 * smaller, more auditable target for the publish-time injector.
 */

// Replaced at npm-publish time by scripts/inject-build-token.mjs, which rewrites
// the compiled build/core/buildInfo.js. A source checkout (any fork) keeps this
// literal — the telemetry Worker compares it to its own secret and resolves a
// non-match to a fork. Never store/commit the real value here.
export const BUILD_TOKEN = "__BUILD_TOKEN__";

// Assembled from two fragments on purpose. Written as a single literal this
// would be a second occurrence of the placeholder in the emitted JS, and the
// injector refuses to publish when it finds anything other than exactly one —
// and would rewrite this comparison value along with the constant above,
// making isPublishedBuild() always false in published builds.
const PLACEHOLDER = "__BUILD" + "_TOKEN__";

/**
 * True when running from an artifact that went through `npm publish` (the token
 * was stamped), false in a source checkout or a fork built from source.
 *
 * The injector fails loudly on a missing or duplicated placeholder, so a
 * published build cannot silently report itself as a checkout.
 *
 * This is a release-channel signal, not a security boundary: anyone can edit
 * build/*.js. It is here to keep ordinary users from unknowingly running the
 * development transport, not to stop a determined local attacker.
 */
export function isPublishedBuild(): boolean {
    return BUILD_TOKEN !== PLACEHOLDER;
}
