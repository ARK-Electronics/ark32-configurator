import { describe, expect, it } from 'vitest';
import { FOUR_WAY_COMMANDS } from '../framing/fourway';
import { MSP_COMMANDS } from '../framing/msp';
import { EEPROM_SIZE } from '../eeprom/layout';
import {
    HOST_MARGIN_MS,
    MSP_PASSTHROUGH_MS,
    SOFT_SERIAL_BAUD,
    TIMEOUT_FLOORS,
    TimeoutPolicy,
    wireMs
} from './timeout-policy';

const generic = new TimeoutPolicy();
const ardupilot = new TimeoutPolicy({ variant: 'ardupilot' });
const betaflight = new TimeoutPolicy({ variant: 'betaflight' });

describe('wireMs', () => {
    it('is 8N1 time on the line', () => {
        // 256 bytes at 19200 8N1 = 256 * 10 / 19200 s = 133.3 ms.
        expect(wireMs(256, SOFT_SERIAL_BAUD)).toBe(134);
        expect(wireMs(0, SOFT_SERIAL_BAUD)).toBe(0);
    });
});

describe('TimeoutPolicy: the number audit C got wrong', () => {
    it('gives a 256-byte flash page write far more than the 200 ms the app used to pass', () => {
        const budget = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWrite, 256);

        // The FC alone allows 500 ms for the CMD_PROG_FLASH ACK, plus ~80 ms for
        // the set-buffer ACK, plus 134 ms of soft-serial wire time. 200 ms was
        // never survivable.
        expect(budget).toBeGreaterThan(700);
        expect(budget).toBeGreaterThanOrEqual(TIMEOUT_FLOORS.fourWayWriteFlash);
        expect(budget).toBeLessThan(1500);
    });

    it('never returns less than the plan floors', () => {
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, 0))
            .toBeGreaterThanOrEqual(TIMEOUT_FLOORS.fourWayRead);
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWrite, 0))
            .toBeGreaterThanOrEqual(TIMEOUT_FLOORS.fourWayWriteFlash);
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom, 0))
            .toBeGreaterThanOrEqual(TIMEOUT_FLOORS.fourWayWriteEeprom);
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DevicePageErase, 0))
            .toBeGreaterThanOrEqual(TIMEOUT_FLOORS.fourWayWriteEeprom);
        expect(generic.forMsp(MSP_COMMANDS.MSP_API_VERSION))
            .toBeGreaterThanOrEqual(TIMEOUT_FLOORS.msp);
    });
});

describe('TimeoutPolicy: scales with payload', () => {
    it('reads scale with the requested byte count', () => {
        const small = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, 16);
        const settings = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE);
        const page = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, 256);

        expect(small).toBeLessThan(settings);
        expect(settings).toBeLessThan(page);
    });

    it('writes scale with the written byte count', () => {
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWrite, 32))
            .toBeLessThan(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWrite, 256));
    });

    it('an EEPROM write gets the FC 3000 ms budget, a flash write does not', () => {
        const eeprom = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWriteEEprom, EEPROM_SIZE);
        const flash = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceWrite, EEPROM_SIZE);
        expect(eeprom).toBeGreaterThan(3000);
        expect(flash).toBeLessThan(1500);
    });
});

describe('TimeoutPolicy: keyed on the FC variant', () => {
    it('allows Betaflight twice ArduPilot per byte on a read', () => {
        // AP: serial_read_bytes(..., req_bytes * 1000us) = 1 ms/byte.
        // BF: START_BIT_TIMEOUT_MS = 2 ms, per byte.
        const ap = ardupilot.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE);
        const bf = betaflight.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE);
        expect(bf - ap).toBe(EEPROM_SIZE + 3);
    });

    it('an unidentified FC gets the worse of the two budgets', () => {
        const unknown = generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE);
        expect(unknown).toBe(betaflight.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE));
        expect(unknown).toBeGreaterThan(ardupilot.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE));
    });

    it('withVariant returns the same instance when nothing changes', () => {
        expect(generic.withVariant('generic')).toBe(generic);
        expect(generic.withVariant('ardupilot')).not.toBe(generic);
        expect(generic.withVariant('ardupilot').variant).toBe('ardupilot');
    });

    it('carries scale and margin across withVariant', () => {
        const tuned = new TimeoutPolicy({ scale: 2, marginMs: 10 }).withVariant('betaflight');
        expect(tuned.scale).toBe(2);
        expect(tuned.marginMs).toBe(10);
    });
});

describe('TimeoutPolicy: MSP', () => {
    it('gives MSP_SET_PASSTHROUGH the 1000 ms ArduPilot declares for it', () => {
        // AP_BLHeli.cpp:592 EXPECT_DELAY_MS(1000) around serial_setup_output,
        // which runs before the reply is sent.
        expect(generic.forMsp(MSP_COMMANDS.MSP_SET_PASSTHROUGH)).toBe(MSP_PASSTHROUGH_MS);
        expect(generic.forMsp(MSP_COMMANDS.MSP_SET_PASSTHROUGH))
            .toBeGreaterThan(generic.forMsp(MSP_COMMANDS.MSP_API_VERSION));
    });

    it('gives an ordinary MSP command the floor plus host margin', () => {
        expect(generic.forMsp(MSP_COMMANDS.MSP_API_VERSION)).toBe(TIMEOUT_FLOORS.msp + HOST_MARGIN_MS);
    });
});

describe('TimeoutPolicy: other 4-way commands', () => {
    it('covers Betaflight cmd_DeviceReset busy-waiting 300 ms before it answers', () => {
        // serial_4way.c:608: while (millis() - m < 300);
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceReset, 1)).toBeGreaterThan(300);
    });

    it('falls back to the interface floor for init flash and friends', () => {
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceInitFlash, 1))
            .toBe(TIMEOUT_FLOORS.fourWayInterface);
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_InterfaceTestAlive, 1))
            .toBe(TIMEOUT_FLOORS.fourWayInterface);
        expect(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_InterfaceExit, 1))
            .toBe(TIMEOUT_FLOORS.fourWayInterface);
    });
});

describe('TimeoutPolicy: scale', () => {
    it('multiplies every derived timeout', () => {
        const doubled = new TimeoutPolicy({ scale: 2 });
        expect(doubled.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE))
            .toBe(generic.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, EEPROM_SIZE) * 2);
        expect(doubled.forMsp(MSP_COMMANDS.MSP_API_VERSION))
            .toBe(generic.forMsp(MSP_COMMANDS.MSP_API_VERSION) * 2);
    });

    it('returns whole milliseconds', () => {
        const odd = new TimeoutPolicy({ scale: 1.37 });
        const value = odd.forFourWay(FOUR_WAY_COMMANDS.cmd_DeviceRead, 100);
        expect(Number.isInteger(value)).toBe(true);
    });
});
