/**
 * `resolveTargets` and `forEachTarget` -- the two things that make a per-channel
 * command partial-safe (audit item **B**, one layer above the session).
 *
 * Both are pure enough to test directly, which matters for the two properties
 * `run.test.ts` cannot reach: what happens to a channel the FC will not address, and
 * that the reported order is channel order rather than the order the work ran in.
 */

import { describe, expect, it } from 'vitest';
import { SessionError } from 'am32-core/errors';
import { forEachTarget, resolveTargets, summariseOutcome } from './targets';

describe('resolveTargets', () => {
    it('expands all to every channel the FC reports', () => {
        expect(resolveTargets('all', 3)).toEqual({ targets: [0, 1, 2], outOfRange: [] });
        expect(resolveTargets('all', 0)).toEqual({ targets: [], outOfRange: [] });
    });

    it('splits named channels into the ones that exist and the ones that do not', () => {
        expect(resolveTargets([0, 4, 1], 2)).toEqual({ targets: [0, 1], outOfRange: [4] });
    });
});

describe('forEachTarget', () => {
    it('captures a per-channel failure instead of throwing', async () => {
        // `Am32Session.enumerate` is the only per-channel API that degrades on its
        // own; `readEsc`, `writeSettings`, `flash` and `reset` all throw, so this is
        // where "four ESCs, one of them dead" turns back into four results.
        const outcomes = await forEachTarget('all', 3, (target) => {
            if (target === 1) {
                return Promise.reject(new SessionError('esc-init', 'ESC #2: did not enter its bootloader'));
            }
            return Promise.resolve(`ok-${target}`);
        });

        expect(outcomes.map(o => o.ok)).toEqual([true, false, true]);
        expect(outcomes[1]?.reason).toBe('esc-init');
        expect(outcomes[1]?.error).toContain('ESC #2');
        expect(outcomes[0]?.value).toBe('ok-0');
    });

    it('gives a non-SessionError the generic reason rather than none', async () => {
        const outcomes = await forEachTarget([0], 1, () => Promise.reject(new Error('boom')));
        expect(outcomes[0]?.reason).toBe('esc-command');
        expect(outcomes[0]?.error).toBe('boom');
    });

    it('runs the channels in the order given, and reports them in channel order', async () => {
        // Two different orders on purpose. 4-way is stateful, so the *work* runs
        // serially in the order the user named -- but `escs[0]` in the JSON envelope
        // has to be the lowest channel, or a script indexing it reads the wrong ESC.
        const ran: number[] = [];
        const outcomes = await forEachTarget([2, 0], 4, (target) => {
            ran.push(target);
            return Promise.resolve(target);
        });

        expect(ran).toEqual([2, 0]);
        expect(outcomes.map(o => o.target)).toEqual([0, 2]);
        expect(outcomes.map(o => o.esc)).toEqual([1, 3]);
    });

    it('sorts a channel the FC will not address into place rather than appending it', async () => {
        // These are appended after the real work, so without the sort `--esc 1,5` on
        // a 2-ESC rig would report channel 5 before channel 1.
        const outcomes = await forEachTarget([0, 4], 2, target => Promise.resolve(target));

        expect(outcomes.map(o => o.esc)).toEqual([1, 5]);
        expect(outcomes[1]?.ok).toBe(false);
        expect(outcomes[1]?.error).toContain('no ESC #5');
        expect(outcomes[1]?.reason).toBe('esc-init');
    });

    it('is a no-op for an empty selection', async () => {
        expect(await forEachTarget([], 4, () => Promise.resolve(1))).toEqual([]);
    });
});

describe('summariseOutcome', () => {
    it('gives every entry the same keys, whatever the outcome', async () => {
        // A machine-readable array whose shape depends on the outcome is one every
        // consumer has to guard, so `reason` and `error` are null on success rather
        // than absent.
        const [ok, failed] = await forEachTarget([0, 1], 2, target => (target === 0
            ? Promise.resolve(1)
            : Promise.reject(new SessionError('esc-verify', 'did not verify'))));

        expect(summariseOutcome(ok!)).toEqual({ esc: 1, target: 0, ok: true, reason: null, error: null });
        expect(summariseOutcome(failed!)).toEqual({
            esc: 2, target: 1, ok: false, reason: 'esc-verify', error: 'did not verify'
        });
    });
});
