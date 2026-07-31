const DEFAULT_LOG_BUFFER_SIZE = 2000;
const DEFAULT_NET_BUFFER_SIZE = 1000;

function sizeFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

/** Per-device console log buffer capacity. Override: EXECBRO_LOG_BUFFER_SIZE. */
export function logBufferSize(): number {
    return sizeFromEnv("EXECBRO_LOG_BUFFER_SIZE", DEFAULT_LOG_BUFFER_SIZE);
}

/** Per-device network request buffer capacity. Override: EXECBRO_NET_BUFFER_SIZE. */
export function networkBufferSize(): number {
    return sizeFromEnv("EXECBRO_NET_BUFFER_SIZE", DEFAULT_NET_BUFFER_SIZE);
}
