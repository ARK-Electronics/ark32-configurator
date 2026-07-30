/**
 * The slice of `node-serialport` this package uses, declared structurally.
 *
 * The same discipline `am32-core`'s `TimerHost` uses on the global timers, and
 * for the same two reasons:
 *
 *  1. **{@link import('./node-serial-transport').NodeSerialTransport} must be
 *     testable without a serial port.** A structural port is satisfied by
 *     `SerialPortMock`, by a hand-written fake, and by the real thing --
 *     `serialport-types.test.ts` asserts the first of those at compile time as
 *     well as at run time, so this interface cannot drift away from the package
 *     without a test going red.
 *  2. **`ark32 --sim` must not load a native module.** `serialport` is an N-API
 *     addon; nothing that only talks to the simulator should need it to be
 *     installed, let alone loadable. Keeping the type structural means the only
 *     file that names the package is {@link import('./serialport-loader')}, which
 *     is reached through a dynamic `import()`.
 *
 * Every member below is what `SerialPort` (a `stream.Duplex` subclass) already
 * provides; nothing here is a wrapper the caller has to build.
 */

/** One entry from `SerialPort.list()`. */
export interface NodePortInfo {
    /** OS device path -- `/dev/ttyACM0`, `COM3`. */
    path: string
    manufacturer?: string
    serialNumber?: string
    pnpId?: string
    locationId?: string
    /** Four lower-case hex digits, no `0x`, as `SerialPort.list()` reports them. */
    vendorId?: string
    productId?: string
}

/** Node's error-first callback, as every `SerialPort` method takes one. */
export type NodeCallback = (error?: Error | null) => void;

export interface NodeSerialPortLike {
    readonly isOpen: boolean
    open(callback: NodeCallback): void
    close(callback: NodeCallback): void
    /**
     * Queue bytes. The callback fires when they have been handed to the binding,
     * not when they have left the UART -- {@link drain} is the second half.
     */
    write(data: Uint8Array, callback: NodeCallback): boolean
    /** Wait for the OS transmit buffer to empty (`tcdrain(2)` on POSIX). */
    drain(callback: NodeCallback): void
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
    on(event: 'error', listener: (error: Error) => void): unknown
    on(event: 'close', listener: () => void): unknown
    removeAllListeners(event?: string): unknown
}

export interface NodeSerialPortOptions {
    path: string
    baudRate: number
    autoOpen: boolean
}

/**
 * The two things this package needs out of `import('serialport')`.
 *
 * `SerialPort` is a constructor rather than a factory because that is what the
 * package exports; `am32-node` never subclasses it.
 */
export interface SerialPortModuleLike {
    SerialPort: {
        new (options: NodeSerialPortOptions): NodeSerialPortLike
        list(): Promise<NodePortInfo[]>
    }
}
