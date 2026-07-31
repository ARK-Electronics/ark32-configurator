/**
 * am32-web — the browser transport for `am32-core`.
 *
 * One class, one job: move bytes over Web Serial. Framing, timeouts, retries
 * and drain all live in the core's link layer, so the browser and the CLI share
 * them by construction. See issue #3 section 2.
 */

export { WebSerialTransport } from './web-serial-transport';
export type { WebSerialTransportOptions } from './web-serial-transport';
