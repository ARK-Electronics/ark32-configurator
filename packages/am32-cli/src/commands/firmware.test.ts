/**
 * `flash --release` against the simulated rig, with a stubbed network.
 *
 * What `run.test.ts` cannot cover: the parser refuses `--sim --release` (a
 * real download await under the virtual clock would deadlock, not wait), so
 * the command function is driven directly here the way `settings.test.ts`
 * drives its commands -- same rig, same clock pump, instant fake downloads.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Am32Session } from 'am32-core/session';
import { parseArgs, type GlobalOptions } from '../args';
import type { CliEnv, HttpResponse } from '../env';
import { createSimRig, driveVirtualClock } from '../sim';
import { commandFlashRelease } from './firmware';
import type { FirmwareRelease } from './releases';

const FIRMWARE_HEX = readFileSync(new URL('../../fixtures/firmware.hex', import.meta.url), 'utf8');

function globalsFor (argv: string[]): GlobalOptions {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'args') {
        throw new Error('the test\'s own command line does not parse');
    }
    return parsed.globals;
}

/** A simulated rig in passthrough, exactly as `settings.test.ts` builds one. */
async function rig () {
    const globals = globalsFor(['--sim', 'enumerate']);
    const sim = createSimRig(globals);
    await sim.harness.open();

    const session = new Am32Session({ transport: sim.harness.transport, clock: sim.clock });
    const drive = <T>(work: () => Promise<T>): Promise<T> => driveVirtualClock(sim.clock, work());

    await drive(() => session.connect());
    const escCount = await drive(() => session.enterPassthrough());
    return { ...sim, session, escCount, drive };
}

/** An env whose network is `responses` and whose everything-else throws. */
function envWith (respond: (url: string) => HttpResponse): { env: CliEnv, urls: string[] } {
    const urls: string[] = [];
    const refuse = (what: string) => () => {
        throw new Error(`flash --release must not touch ${what}`);
    };
    const env: CliEnv = {
        stdout: refuse('stdout'),
        stderr: refuse('stderr'),
        readFile: refuse('the filesystem'),
        readTextFile: refuse('the filesystem'),
        writeFile: refuse('the filesystem'),
        ensureDir: refuse('the filesystem'),
        joinPath: refuse('the filesystem'),
        openPort: refuse('a serial port'),
        listPorts: refuse('a serial port'),
        httpGet: (url) => {
            urls.push(url);
            return Promise.resolve(respond(url));
        },
        firmware: { owner: 'ARK-Electronics', repo: 'ARK32', token: null },
        version: '0.0.0-test'
    };
    return { env, urls };
}

const NIGHTLY: FirmwareRelease = {
    tag: 'nightly',
    prerelease: true,
    publishedAt: '2026-07-30T06:56:32Z',
    assets: [
        { name: 'AM32_ARK_4IN1_F051_3.0-ark.hex', downloadUrl: 'https://example.test/ark4in1' },
        { name: 'AM32_REF_G431_3.0-ark.hex', downloadUrl: 'https://example.test/g431' }
    ]
};

describe('commandFlashRelease', () => {
    it('matches each ESC\'s asset by its own firmware name and downloads it once', async () => {
        const h = await rig();
        const { env, urls } = envWith(() => ({ status: 200, body: FIRMWARE_HEX }));

        const outcome = await h.drive(() => commandFlashRelease(
            h.session, 'all', h.escCount, NIGHTLY, env,
            { allowMcuMismatch: false, verify: true }
        ));

        expect(outcome.exitCode).toBe(0);
        const escs = outcome.data.escs as { ok: boolean, asset: string | null }[];
        expect(escs.every(esc => esc.ok)).toBe(true);
        expect(escs.map(esc => esc.asset))
            .toEqual(Array.from({ length: 4 }, () => 'AM32_ARK_4IN1_F051_3.0-ark.hex'));
        // Four ESCs, one distinct asset: the download is shared, not repeated.
        expect(urls).toEqual(['https://example.test/ark4in1']);
    });

    it('fails the channel, not the command, when the release has nothing for it', async () => {
        const h = await rig();
        const { env, urls } = envWith(() => ({ status: 200, body: FIRMWARE_HEX }));
        const empty: FirmwareRelease = { ...NIGHTLY, assets: [NIGHTLY.assets[1] as FirmwareRelease['assets'][0]] };

        const outcome = await h.drive(() => commandFlashRelease(
            h.session, 'all', h.escCount, empty, env,
            { allowMcuMismatch: false, verify: true }
        ));

        expect(outcome.exitCode).toBe(1);
        const escs = outcome.data.escs as { ok: boolean, error?: string }[];
        expect(escs.every(esc => !esc.ok)).toBe(true);
        expect(escs[0]?.error).toContain('carries no asset for ARK_4IN1_F051');
        expect(urls).toEqual([]);
    });

    it('fails the channel when the downloaded asset is not Intel HEX', async () => {
        const h = await rig();
        const { env } = envWith(() => ({ status: 200, body: 'not a hex file' }));

        const outcome = await h.drive(() => commandFlashRelease(
            h.session, 'all', h.escCount, NIGHTLY, env,
            { allowMcuMismatch: false, verify: true }
        ));

        expect(outcome.exitCode).toBe(1);
        const escs = outcome.data.escs as { ok: boolean, error?: string }[];
        expect(escs[0]?.error).toContain('not a valid Intel HEX');
    });
});
