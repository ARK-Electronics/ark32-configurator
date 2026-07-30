/**
 * One call from a device path to an open {@link NodeSerialTransport}.
 *
 * Separate from the transport so that the transport keeps no knowledge of how
 * `serialport` is found, and separate from the loader so the loader keeps no
 * knowledge of the `Transport` interface. The CLI wants exactly this one
 * function; anything that wants to substitute the port factory constructs the
 * transport directly.
 */

import { NodeSerialTransport } from './node-serial-transport';
import { loadSerialPortModule, type LoadSerialPortOptions } from './serialport-loader';

export interface OpenNodeTransportOptions extends LoadSerialPortOptions {
    path: string
    baudRate: number
    onError?: (error: Error) => void
    log?: (message: string) => void
}

export async function openNodeTransport (
    options: OpenNodeTransportOptions
): Promise<NodeSerialTransport> {
    const { SerialPort } = await loadSerialPortModule(options);

    const transport = new NodeSerialTransport({
        path: options.path,
        createPort: portOptions => new SerialPort(portOptions),
        onError: options.onError,
        log: options.log
    });

    await transport.open({ baudRate: options.baudRate });
    return transport;
}
