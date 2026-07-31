/**
 * The argument parser, which is where exit code 3 is decided.
 *
 * Section 6 of issue #3 makes "bad arguments" a specified exit code, so every case
 * that should produce one is a behaviour with a test rather than whatever a parser
 * library happened to do. The parser is pure, so this file can be exhaustive: it is
 * the cheapest coverage in the block and it is what stops `ark32 flash --esc all`
 * with a typo'd flag from silently flashing something.
 */

import { describe, expect, it } from 'vitest';
import { COMMANDS, DEFAULT_BAUD_RATE, DEFAULT_SIM_ESCS, parseArgs, type ParseSuccess } from './args';

/** Parse, and fail the test with the parser's own message if it did not succeed. */
function ok (argv: string[]): ParseSuccess {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'args') {
        throw new Error(`expected a parse, got ${parsed.kind}: ${'message' in parsed ? parsed.message : ''}`);
    }
    return parsed;
}

function why (argv: string[]): string {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'failure') {
        throw new Error(`expected a failure, got ${parsed.kind}`);
    }
    return parsed.message;
}

describe('parseArgs: releases and flash --release', () => {
    it('parses releases, which needs neither a port nor --esc', () => {
        const parsed = ok(['releases']);
        expect(parsed.command).toBe('releases');
        expect(parsed.globals.port).toBeNull();
    });

    it('rejects flags releases does not take', () => {
        expect(why(['releases', '--esc', 'all'])).toContain('releases does not take --esc');
    });

    it('parses flash --release', () => {
        const parsed = ok(['-p', '/dev/ttyACM0', 'flash', '--esc', 'all', '--release', 'nightly']);
        expect(parsed.release).toBe('nightly');
        expect(parsed.hex).toBeNull();
    });

    it('rejects --hex and --release together', () => {
        expect(why(['-p', 'x', 'flash', '--esc', 'all', '--hex', 'a.hex', '--release', 'nightly']))
            .toContain('not both');
    });

    it('names both roads when flash has neither', () => {
        expect(why(['-p', 'x', 'flash', '--esc', 'all'])).toContain('--release');
    });

    it('rejects --release under --sim, naming the offline reason', () => {
        expect(why(['--sim', 'flash', '--esc', 'all', '--release', 'nightly'])).toContain('offline');
    });
});

describe('parseArgs: help and version', () => {
    it('answers --help anywhere on the line, before validating anything else', () => {
        expect(parseArgs(['--help']).kind).toBe('help');
        expect(parseArgs(['-h']).kind).toBe('help');
        // Even in the middle of a command line that would otherwise be rejected.
        expect(parseArgs(['flash', '--help']).kind).toBe('help');
    });

    it('answers --version', () => {
        expect(parseArgs(['--version']).kind).toBe('version');
    });

    it('lists every command and every exit code in the usage text', () => {
        const help = parseArgs(['--help']);
        if (help.kind !== 'help') {
            throw new Error('not help');
        }
        for (const command of COMMANDS) {
            expect(help.text).toContain(command);
        }
        // The exit-code table is the contract a script depends on, so it has to be
        // in --help and not only in the plan.
        expect(help.text).toContain('0 success');
        expect(help.text).toContain('1 some ESCs failed');
        expect(help.text).toContain('2 connect or FC detection failed');
        expect(help.text).toContain('3 bad arguments');
    });
});

describe('parseArgs: commands', () => {
    it('rejects no command', () => {
        expect(why([])).toContain('no command given');
        expect(why(['--sim'])).toContain('no command given');
    });

    it('rejects an unknown command, and says what it knows', () => {
        const message = why(['enumrate', '--sim']);
        expect(message).toContain("unknown command 'enumrate'");
        expect(message).toContain('enumerate');
    });

    it('rejects an unknown flag', () => {
        expect(why(['--sim', 'enumerate', '--fast'])).toContain("unknown flag '--fast'");
    });

    it('rejects a flag the command does not take', () => {
        // `read --hex fw.hex` should not silently read settings and ignore the hex.
        expect(why(['--sim', 'read', '--esc', 'all', '-o', 'out', '--hex', 'fw.hex']))
            .toBe('read does not take --hex');
        expect(why(['--sim', 'enumerate', '--esc', 'all'])).toBe('enumerate does not take --esc');
        expect(why(['--sim', 'reset', '--esc', 'all', '--no-verify']))
            .toBe('reset does not take --no-verify');
    });

    it('rejects positional arguments on a command that takes none', () => {
        expect(why(['--sim', 'enumerate', 'extra'])).toContain('takes no positional arguments');
    });

    it('accepts positional arguments on get and set', () => {
        expect(ok(['--sim', 'get', '--esc', '1', 'TIMING_ADVANCE', 'MOTOR_KV']).operands)
            .toEqual(['TIMING_ADVANCE', 'MOTOR_KV']);
        expect(ok(['--sim', 'set', '--esc', 'all', 'TIMING_ADVANCE=16']).operands)
            .toEqual(['TIMING_ADVANCE=16']);
    });

    it('requires at least one KEY=VALUE for set', () => {
        expect(why(['--sim', 'set', '--esc', 'all'])).toContain('needs at least one KEY=VALUE');
    });
});

describe('parseArgs: --esc', () => {
    it('is required by every command that takes it', () => {
        for (const command of ['read', 'write', 'get', 'set', 'defaults', 'flash', 'reset']) {
            expect(why(['--sim', command])).toContain(`${command} needs --esc`);
        }
    });

    it('resolves 1-based channels to zero-based targets', () => {
        // 1-based because that is how --esc, --fault escN, the UI and every log
        // line in this codebase number ESCs. Off by one here is a wrong ESC.
        expect(ok(['--sim', 'get', '--esc', '1']).escs).toEqual([0]);
        expect(ok(['--sim', 'get', '--esc', '3']).escs).toEqual([2]);
    });

    it('accepts all', () => {
        expect(ok(['--sim', 'get', '--esc', 'all']).escs).toBe('all');
    });

    it('accepts a comma list, de-duplicated and in the order given', () => {
        expect(ok(['--sim', 'get', '--esc', '3,1,3']).escs).toEqual([2, 0]);
    });

    it('rejects 0, which is not a channel number', () => {
        expect(why(['--sim', 'get', '--esc', '0'])).toContain('1-based');
    });

    it('rejects anything that is not a channel or all', () => {
        expect(why(['--sim', 'get', '--esc', 'first'])).toContain("got 'first'");
        expect(why(['--sim', 'get', '--esc', '-1'])).toContain("got '-1'");
    });
});

describe('parseArgs: global flags', () => {
    it('defaults baud, fc, timeout scale and the simulated ESC count', () => {
        const args = ok(['--sim', 'enumerate']);
        expect(args.globals.baud).toBe(DEFAULT_BAUD_RATE);
        expect(args.globals.fc).toBe('auto');
        expect(args.globals.timeoutScale).toBe(1);
        expect(args.globals.escs).toBe(DEFAULT_SIM_ESCS);
        expect(args.verify).toBe(true);
    });

    it('accepts --flag=value as well as --flag value', () => {
        expect(ok(['--sim', '--escs=2', 'enumerate']).globals.escs).toBe(2);
        expect(ok(['--sim', '--fc=betaflight', 'enumerate']).globals.fc).toBe('betaflight');
    });

    it('rejects a flag with no value', () => {
        expect(why(['--sim', 'enumerate', '--baud'])).toBe('--baud needs a value');
        expect(why(['--baud', '--sim', 'enumerate'])).toBe('--baud needs a value');
    });

    it('validates --baud, --fc and --timeout-scale', () => {
        expect(why(['--sim', '--baud', 'fast', 'enumerate'])).toContain('whole number');
        expect(why(['--sim', '--fc', 'inav', 'enumerate'])).toContain('auto | ardupilot | betaflight');
        expect(why(['--sim', '--timeout-scale', '0', 'enumerate'])).toContain('positive number');
        expect(ok(['--sim', '--timeout-scale', '2.5', 'enumerate']).globals.timeoutScale).toBe(2.5);
    });

    it('turns --no-verify off for every write path', () => {
        for (const argv of [
            ['--sim', 'write', '--esc', 'all', '-i', 'f.bin', '--no-verify'],
            ['--sim', 'set', '--esc', 'all', 'TIMING_ADVANCE=16', '--no-verify'],
            ['--sim', 'defaults', '--esc', 'all', '--no-verify'],
            ['--sim', 'flash', '--esc', 'all', '--hex', 'f.hex', '--no-verify']
        ]) {
            expect(ok(argv).verify).toBe(false);
        }
    });
});

describe('parseArgs: hardware and --sim are exclusive', () => {
    it('requires -p/--port without --sim', () => {
        expect(why(['enumerate'])).toContain('needs -p/--port, or --sim');
    });

    it('lets ports run with neither', () => {
        // Listing ports is the one thing you do before you know which port to name.
        expect(ok(['ports']).command).toBe('ports');
    });

    it('rejects --sim together with a port', () => {
        expect(why(['--sim', '-p', '/dev/ttyACM0', 'enumerate']))
            .toContain('mutually exclusive');
    });

    it('rejects --fault and --escs without --sim rather than ignoring them', () => {
        // Silence here would mean a user who thinks they are injecting a fault into
        // real hardware, and is not.
        expect(why(['-p', '/dev/ttyACM0', '--fault', 'esc1=unresponsive', 'enumerate']))
            .toContain('--fault only applies to --sim');
        expect(why(['-p', '/dev/ttyACM0', '--escs', '2', 'enumerate']))
            .toContain('--escs only applies to --sim');
    });
});

describe('parseArgs: --fault', () => {
    it('resolves escN to the same zero-based target --esc does', () => {
        const [fault] = ok(['--sim', '--fault', 'esc3=unresponsive', 'enumerate']).globals.faults;
        expect(fault).toEqual({
            subject: 'esc3',
            scope: 'esc',
            target: 2,
            knob: 'unresponsive',
            value: null
        });
    });

    it('is repeatable', () => {
        const args = ok([
            '--sim', '--fault', 'esc1=slowBy:600', '--fault', 'esc2=corruptCrc:2', 'enumerate'
        ]);
        expect(args.globals.faults.map(f => f.knob)).toEqual(['slowBy', 'corruptCrc']);
    });

    it('requires a value where the knob measures something', () => {
        expect(why(['--sim', '--fault', 'esc1=slowBy', 'enumerate']))
            .toContain('needs a value, as slowBy:N');
        expect(why(['--sim', '--fault', 'link=dropBytes', 'enumerate'])).toContain('needs a value');
        expect(ok(['--sim', '--fault', 'esc1=slowBy:600', 'enumerate']).globals.faults[0]?.value)
            .toBe(600);
    });

    it('defaults a counted knob to "every time"', () => {
        expect(ok(['--sim', '--fault', 'esc1=corruptCrc', 'enumerate']).globals.faults[0]?.value)
            .toBe(true);
        expect(ok(['--sim', '--fault', 'esc1=corruptCrc:2', 'enumerate']).globals.faults[0]?.value)
            .toBe(2);
    });

    it('rejects a value on a knob that takes none', () => {
        expect(why(['--sim', '--fault', 'esc1=unresponsive:1', 'enumerate']))
            .toContain('takes no value');
    });

    it('reads fc=blockingFourWay as a flag, either way round', () => {
        expect(ok(['--sim', '--fault', 'fc=blockingFourWay', 'enumerate']).globals.faults[0]?.value)
            .toBe(true);
        expect(ok(['--sim', '--fault', 'fc=blockingFourWay:false', 'enumerate']).globals.faults[0]?.value)
            .toBe(false);
        expect(why(['--sim', '--fault', 'fc=blockingFourWay:maybe', 'enumerate']))
            .toContain('takes true or false');
    });

    it('parses bootloaderDropout bare and counted', () => {
        expect(ok(['--sim', '--fault', 'esc1=bootloaderDropout', 'enumerate']).globals.faults[0])
            .toMatchObject({ scope: 'esc', target: 0, knob: 'bootloaderDropout', value: true });
        expect(ok(['--sim', '--fault', 'esc1=bootloaderDropout:40', 'enumerate']).globals.faults[0])
            .toMatchObject({ knob: 'bootloaderDropout', value: 40 });
    });

    it('rejects an unknown subject or knob, and lists the knobs it knows', () => {
        expect(why(['--sim', '--fault', 'motor1=unresponsive', 'enumerate']))
            .toContain('subject must be escN, fc or link');
        const message = why(['--sim', '--fault', 'esc1=explode', 'enumerate']);
        expect(message).toContain('unknown esc knob');
        expect(message).toContain('silentWriteFailure');
        expect(why(['--sim', '--fault', 'fc=dropBytes:2', 'enumerate'])).toContain('unknown fc knob');
    });

    it('rejects a malformed spec', () => {
        expect(why(['--sim', '--fault', 'esc1', 'enumerate'])).toContain('needs SUBJECT=KNOB');
        expect(why(['--sim', '--fault', 'esc1=', 'enumerate'])).toContain('names no knob');
    });

    it('rejects a channel the rig will not have, whichever order the flags come in', () => {
        // Otherwise the knob is applied to nothing and the run looks like the fault
        // simply did not fire.
        expect(why(['--sim', '--escs', '2', '--fault', 'esc3=unresponsive', 'enumerate']))
            .toContain('the rig has 2 ESC(s)');
        expect(why(['--sim', '--fault', 'esc3=unresponsive', '--escs', '2', 'enumerate']))
            .toContain('the rig has 2 ESC(s)');
    });
});

describe('parseArgs: required file arguments', () => {
    it('read needs -o, write needs -i, flash needs --hex', () => {
        expect(why(['--sim', 'read', '--esc', 'all'])).toContain('read needs -o/--out');
        expect(why(['--sim', 'write', '--esc', 'all'])).toContain('write needs -i/--in');
        expect(why(['--sim', 'flash', '--esc', 'all'])).toContain('flash needs --hex');
    });

    it('takes the short and long forms as the same flag', () => {
        expect(ok(['--sim', 'read', '--esc', 'all', '-o', 'dir']).out).toBe('dir');
        expect(ok(['--sim', 'read', '--esc', 'all', '--out', 'dir']).out).toBe('dir');
        expect(ok(['--sim', 'write', '--esc', 'all', '-i', 'f.bin']).input).toBe('f.bin');
        expect(ok(['--sim', 'write', '--esc', 'all', '--in', 'f.bin']).input).toBe('f.bin');
    });
});

describe('parseArgs: the plan\'s own two done-when command lines', () => {
    it('parses `ark32 --sim enumerate --escs 4`', () => {
        const args = ok(['--sim', 'enumerate', '--escs', '4']);
        expect(args.command).toBe('enumerate');
        expect(args.globals.sim).toBe(true);
        expect(args.globals.escs).toBe(4);
    });

    it('parses `ark32 --sim write --esc all -i fixture.bin`', () => {
        const args = ok(['--sim', 'write', '--esc', 'all', '-i', 'fixture.bin']);
        expect(args.command).toBe('write');
        expect(args.escs).toBe('all');
        expect(args.input).toBe('fixture.bin');
        expect(args.verify).toBe(true);
    });
});
