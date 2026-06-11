import { afterEach } from "@jest/globals";

afterEach(async () => {
    try {
        const { cancelAllReconnectionTimers, clearAllConnectionState } = await import(
            "../core/connectionState.js"
        );
        const { pendingExecutions } = await import("../core/state.js");
        cancelAllReconnectionTimers();
        clearAllConnectionState();
        pendingExecutions.clear();
    } catch (e) {
        // Silently ignore import errors in test environment
        // Some core modules use import.meta which may not work in all Jest contexts
    }
});
