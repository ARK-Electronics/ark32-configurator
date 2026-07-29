/**
 * am32-core — the transport-agnostic protocol core.
 *
 * Skeleton only. Block 1b fills this in (eeprom codec, MSP + 4-way framing,
 * Mcu, hex), block 2 adds the link layer and Clock, block 4 adds Am32Session.
 * See docs/plans/overhaul/STATUS.json and issue #3.
 */

/**
 * Size of AM32's `EEprom_t` in bytes.
 *
 * Matches `union EEprom_u { ...; uint8_t buffer[192]; }` in AM32 `Inc/eeprom.h`
 * on the `ark-release` branch. The CAN block occupies bytes 176-183 and is
 * followed by `reserved[8]` at 184-191.
 *
 * This replaces the old `Mcu.LAYOUT_SIZE` of 0xB8 (184), which truncated the
 * buffer eight bytes short of the struct and is the root of audit item A.
 */
export const EEPROM_SIZE = 192;

/**
 * The one extension point of the whole stack.
 *
 * Transports move bytes and nothing else: no framing, no timeouts, no retries,
 * no drain. Everything that could differ between the browser, Node, the
 * simulator and (later) Tauri is therefore forced up into the link layer, which
 * is what makes the UI and CLI paths identical by construction rather than by
 * discipline.
 */
export interface Transport {
    open(opts: { baudRate: number }): Promise<void>
    close(): Promise<void>
    write(data: Uint8Array): Promise<void>
    onData(cb: (chunk: Uint8Array) => void): () => void
    readonly isOpen: boolean
}
