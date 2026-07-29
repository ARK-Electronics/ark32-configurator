/**
 * The one extension point of the whole stack.
 *
 * Transports move bytes and nothing else: no framing, no timeouts, no retries,
 * no drain. Everything that could differ between the browser, Node, the
 * simulator and (later) Tauri is therefore forced up into the link layer, which
 * is what makes the UI and CLI paths identical by construction rather than by
 * discipline.
 *
 * Implementations: `packages/am32-web` (Web Serial), later `am32-node`
 * (serialport) and `am32-sim` (simulated FC + ESCs).
 */
export interface Transport {
    open(opts: { baudRate: number }): Promise<void>
    close(): Promise<void>
    write(data: Uint8Array): Promise<void>
    /** Subscribe to inbound bytes. Returns an unsubscribe function. */
    onData(cb: (chunk: Uint8Array) => void): () => void
    readonly isOpen: boolean
}
