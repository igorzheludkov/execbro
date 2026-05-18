import { afterEach } from "@jest/globals";

afterEach(async () => {
    const { cancelAllReconnectionTimers, clearAllConnectionState } = await import(
        "../core/connectionState.js"
    );
    const { pendingExecutions } = await import("../core/state.js");
    cancelAllReconnectionTimers();
    clearAllConnectionState();
    pendingExecutions.clear();
});
