/**
 * am32-node -- the Node transport for `am32-core`.
 *
 * A peer of `am32-web` and `am32-sim`, not a variant of either: one
 * `Transport` interface, four implementations (issue #3 section 7.3). Nothing
 * here knows what a frame is.
 *
 * Never imported by the Nuxt app. There is no `nuxt.config.ts` alias for it, and
 * `serialport` would not survive a browser bundle if there were.
 */

export { NodeSerialTransport } from './node-serial-transport';
export type { NodeSerialTransportOptions } from './node-serial-transport';

export {
    SERIALPORT_MISSING_HINT,
    SerialPortUnavailableError,
    listSerialPorts,
    loadSerialPortModule,
    serialPortCandidates
} from './serialport-loader';
export type { LoadSerialPortOptions, ModuleImporter } from './serialport-loader';

export type {
    NodeCallback,
    NodePortInfo,
    NodeSerialPortLike,
    NodeSerialPortOptions,
    SerialPortModuleLike
} from './serialport-types';

export { openNodeTransport } from './open';
export type { OpenNodeTransportOptions } from './open';
