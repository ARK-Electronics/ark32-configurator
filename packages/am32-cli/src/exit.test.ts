/**
 * The exit-code table from issue #3 section 6.
 *
 * Worth testing directly rather than only through `run()`, because the two
 * interesting rows are not reachable from a happy path: `esc-verify`, which block 6
 * added after the table was written, and the `image`-only rule, which is the one
 * place a per-channel failure becomes exit 3.
 */

import { describe, expect, it } from 'vitest';
import { LinkError } from 'am32-core/link/link';
import { SessionError } from 'am32-core/errors';
import { EEPROM_SIZE } from 'am32-core/eeprom/layout';
import { FOUR_WAY_COMMANDS } from 'am32-core/framing/fourway';
import type { FcVariant } from 'am32-core/link/timeout-policy';
import type { GlobalOptions } from './args';
import { timeoutPolicyFor } from './run';
import {
    EXIT_CONNECT,
    EXIT_OK,
    EXIT_PARTIAL,
    EXIT_USAGE,
    exitCodeForError,
    exitCodeForTargets
} from './exit';

describe('exitCodeForError', () => {
    it('maps every flight-controller-level reason to 2', () => {
        for (const reason of ['transport', 'fc-detect', 'passthrough', 'not-connected'] as const) {
            expect(exitCodeForError(new SessionError(reason, reason))).toBe(EXIT_CONNECT);
        }
    });

    it('maps every ESC-level reason to 1', () => {
        for (const reason of ['esc-init', 'esc-read', 'esc-command'] as const) {
            expect(exitCodeForError(new SessionError(reason, reason))).toBe(EXIT_PARTIAL);
        }
    });

    it('maps esc-verify to 1, not to a code of its own', () => {
        // Block 6 added this reason and its note flags that section 6's table does
        // not cover it. The ESC is healthy and answering, so it is not 2; the
        // arguments were fine, so it is not 3; and "the write did not read back" on
        // one of four channels is exactly what 1 means.
        expect(exitCodeForError(new SessionError('esc-verify', 'did not verify'))).toBe(EXIT_PARTIAL);
    });

    it('maps image to 3, because it is a bad argument found on the wire', () => {
        expect(exitCodeForError(new SessionError('image', 'not Intel HEX'))).toBe(EXIT_USAGE);
    });

    it('unwraps the SessionError a LinkError grew out of', () => {
        // Link.request wraps whatever `validate` throws, so the reason is one or two
        // levels down. Flattening it would report every 4-way failure the same way.
        const wrapped = new LinkError('validate', 'validate rejected', 1, {
            cause: new SessionError('fc-detect', 'no FC answered')
        });
        expect(exitCodeForError(wrapped)).toBe(EXIT_CONNECT);
    });

    it('gives anything that is not a SessionError the non-committal 1', () => {
        // A plain Error got past every guard the session has, so it is not a
        // diagnosis: 1 keeps it out of the two codes that make a specific claim.
        expect(exitCodeForError(new Error('undefined is not a function'))).toBe(EXIT_PARTIAL);
        expect(exitCodeForError('a string')).toBe(EXIT_PARTIAL);
    });
});

describe('exitCodeForTargets', () => {
    it('is 0 when every channel succeeded, and when there were none', () => {
        expect(exitCodeForTargets([])).toBe(EXIT_OK);
        expect(exitCodeForTargets([{ ok: true }, { ok: true }])).toBe(EXIT_OK);
    });

    it('is 1 when some channels failed', () => {
        expect(exitCodeForTargets([{ ok: true }, { ok: false, reason: 'esc-init' }]))
            .toBe(EXIT_PARTIAL);
    });

    it('is 1 when every channel failed for an ESC-level reason', () => {
        expect(exitCodeForTargets([
            { ok: false, reason: 'esc-init' },
            { ok: false, reason: 'esc-verify' }
        ])).toBe(EXIT_PARTIAL);
    });

    it('is 3 only when every channel rejected the argument itself', () => {
        expect(exitCodeForTargets([
            { ok: false, reason: 'image' },
            { ok: false, reason: 'image' }
        ])).toBe(EXIT_USAGE);
    });

    it('lets a partial success outrank the argument error', () => {
        // Something was written, so 3 would be a lie: it has to keep meaning
        // "nothing was attempted".
        expect(exitCodeForTargets([{ ok: true }, { ok: false, reason: 'image' }]))
            .toBe(EXIT_PARTIAL);
        expect(exitCodeForTargets([
            { ok: false, reason: 'image' },
            { ok: false, reason: 'esc-init' }
        ])).toBe(EXIT_PARTIAL);
    });
});

// ---- the two flags that change durations and nothing observable -------------

describe('timeoutPolicyFor', () => {
    const globals = (overrides: Partial<GlobalOptions> = {}): GlobalOptions => ({
        port: null,
        baud: 115200,
        fc: 'auto',
        json: false,
        verbose: false,
        timeoutScale: 1,
        sim: true,
        escs: 4,
        faults: [],
        ...overrides
    });

    it('maps --fc auto to generic, which takes the worse of the two budgets', () => {
        const policy = timeoutPolicyFor(globals());
        expect(policy.variant).toBe('generic');

        // Betaflight allows itself 2 ms per byte on a read where ArduPilot allows 1,
        // and `generic` must not be given the tighter of the two before detection.
        const read = (variant: FcVariant) =>
            timeoutPolicyFor(globals({ fc: variant === 'generic' ? 'auto' : variant }))
                .forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE);
        expect(read('generic')).toBeGreaterThanOrEqual(read('ardupilot'));
        expect(read('generic')).toBe(read('betaflight'));
    });

    it('passes --fc through as the variant', () => {
        expect(timeoutPolicyFor(globals({ fc: 'ardupilot' })).variant).toBe('ardupilot');
        expect(timeoutPolicyFor(globals({ fc: 'betaflight' })).variant).toBe('betaflight');
    });

    it('passes --timeout-scale through, and it multiplies a derived timeout', () => {
        // The only reason this test exists: `scale` changes durations and nothing
        // else, so a `--sim` run with no faults completes identically whether it is
        // wired up or not. Nothing above `withRig` could notice it being dropped.
        const plain = timeoutPolicyFor(globals());
        const doubled = timeoutPolicyFor(globals({ timeoutScale: 2 }));

        const read = (policy: ReturnType<typeof timeoutPolicyFor>) =>
            policy.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE);

        expect(doubled.scale).toBe(2);
        expect(read(doubled)).toBe(read(plain) * 2);
    });
});
