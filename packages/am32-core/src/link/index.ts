/**
 * The link layer. Everything below the session layer that touches time or the
 * wire lives here.
 *
 * Block 5's ESLint `no-restricted-imports` rule names `am32-core/link`: Vue
 * components must go through the session API, not through this.
 */

export { Link, LinkError } from './link';
export type {
    LinkErrorReason,
    LinkOptions,
    LinkProbe,
    LinkRequestOptions,
    LinkStats,
    LinkValidator
} from './link';

export {
    DEFAULT_TIMEOUT_POLICY,
    HOST_LINK_BAUD,
    HOST_MARGIN_MS,
    MSP_PASSTHROUGH_MS,
    SOFT_SERIAL_BAUD,
    TIMEOUT_FLOORS,
    TimeoutPolicy,
    wireMs
} from './timeout-policy';
export type { FcVariant, TimeoutPolicyOptions } from './timeout-policy';
