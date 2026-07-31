/**
 * `ark32 ports` -- the one command that needs no flight controller.
 *
 * Unfiltered, unlike the app's port picker. The browser filters on a vendor-ID
 * allow-list because a Web Serial prompt has to show something short, but a CLI
 * that hides the device the user is holding is worse than one that lists a few
 * they do not want -- especially on a board behind a USB-serial bridge, whose VID
 * belongs to FTDI or Silicon Labs rather than to the flight controller. VID:PID
 * is printed so they can tell which is which.
 */

import type { NodePortInfo } from 'am32-node/serialport-types';
import type { CliEnv } from '../env';
import { EXIT_OK } from '../exit';
import type { CommandOutcome } from '../report';

/**
 * What `--sim` reports.
 *
 * A synthetic entry rather than an error or an empty list, because `--sim` is
 * documented as running *any* command against the simulator: a caller scripting
 * `ports | info | enumerate` should get the same shape from all three. The path is
 * `sim`, which is also what `--sim` needs in place of `-p`, so the output stays
 * honest about what it is.
 */
const SIM_PORT: NodePortInfo = {
    path: 'sim',
    manufacturer: 'am32-sim (--sim; no hardware)'
};

const vidPid = (port: NodePortInfo): string =>
    (port.vendorId && port.productId ? `${port.vendorId}:${port.productId}` : '-');

export async function commandPorts (env: CliEnv, sim: boolean): Promise<CommandOutcome> {
    const ports = sim ? [SIM_PORT] : await env.listPorts();

    const lines = ports.length === 0
        ? ['no serial ports found']
        : ports.map(port => [
            port.path.padEnd(24),
            vidPid(port).padEnd(10),
            port.manufacturer ?? '',
            port.serialNumber ? `(${port.serialNumber})` : ''
        ].join(' ').trimEnd());

    return {
        data: {
            ports: ports.map(port => ({
                path: port.path,
                vendorId: port.vendorId ?? null,
                productId: port.productId ?? null,
                manufacturer: port.manufacturer ?? null,
                serialNumber: port.serialNumber ?? null
            }))
        },
        lines,
        // No ports is not a failure. A user with nothing plugged in asked a
        // question and got a true answer.
        exitCode: EXIT_OK
    };
}
