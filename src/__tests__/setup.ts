import { afterEach } from "@jest/globals";
import { cancelAllReconnectionTimers, clearAllConnectionState } from "../core/connectionState.js";
import { pendingExecutions } from "../core/state.js";

// Ensure no reconnection timers or connection state leaks between tests,
// even when a real Metro server is running during test execution.
afterEach(() => {
    cancelAllReconnectionTimers();
    clearAllConnectionState();
    pendingExecutions.clear();
});
