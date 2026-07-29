/**
 * am32-sim -- a simulated flight controller and its ESCs, behind the same
 * `Transport` interface as the real ones.
 *
 * It is a peer of `am32-web` and (later) `am32-node`, not a test-only mock.
 * That is the enforcement behind issue #3 section 7.3: anything the session
 * layer needs that a transport cannot provide shows up immediately as a hole
 * here, so the web and CLI paths stay identical by construction.
 *
 * Never imported by the Nuxt app -- there is no `nuxt.config.ts` alias for it,
 * on purpose.
 */

export { SimTransport } from './transport';
export type { SimEndpoint, SimTransportOptions } from './transport';

export { LinkFaults, garbageBytes } from './faults';
export type { DropBytesOptions, FaultDirection, InjectGarbageOptions } from './faults';

export {
    BR_ERROR_COMMAND,
    BR_ERROR_CRC,
    BR_NONE,
    BR_SUCCESS,
    FIRMWARE_START,
    SimEsc
} from './esc';
export type { EscAck, EscResult, SimEscOptions } from './esc';

export { SimFc } from './fc';
export type { SimFcBattery, SimFcOptions } from './fc';

export {
    ARDUPILOT_PROFILE,
    BETAFLIGHT_PROFILE,
    INTERFACE_MODE_ARM_BLB,
    PROFILES
} from './profiles';
export type { FcProfile, FcProfileName } from './profiles';

export { createSimHarness } from './harness';
export type { SimHarness, SimHarnessOptions } from './harness';
