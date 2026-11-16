// Preloaded into jest by scripts/check-no-device-contact.sh (never by the normal suite).
// Logs, then refuses, every TCP connect to a port a debuggable app is served on:
// Metro's scan range (8081-8090), legacy Expo (19000-19002), Chromium's 9222.
// Refusing is what keeps a leaking test off the developer's running app while the
// check runs; it is also why this is opt-in, since a refused connect tells the code
// under test that Metro is down (CLAUDE.md: a harness must not lie to the code).
const net = require("net");
const fs = require("fs");

const LOG = process.env.METRO_CONTACT_LOG;
const isAppPort = (p) => (p >= 8081 && p <= 8090) || (p >= 19000 && p <= 19002) || p === 9222;
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
    // Node's own callers (http, undici) pass a normalized [options, cb] array.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const port = Number(typeof first === "object" && first !== null ? first.port : first);
    if (isAppPort(port)) {
        const frames = new Error().stack.split("\n").filter((l) => /\/src\//.test(l)).slice(0, 10);
        if (LOG) fs.appendFileSync(LOG, `--- connect to port ${port}\n${frames.join("\n")}\n`);
        process.nextTick(() => this.destroy(new Error("refused by scripts/no-metro-contact.cjs")));
        return this;
    }
    return connect.apply(this, args);
};
