/**
 * AM32 EEPROM layout.
 *
 * Moved out of the Nuxt app's `src/eeprom.ts` in block 1b. The offsets mirror
 * `EEprom_t` in AM32 `Inc/eeprom.h` on the `ark-release` branch.
 */

/**
 * Size of AM32's `EEprom_t` in bytes.
 *
 * Matches `union EEprom_u { ...; uint8_t buffer[192]; }` in AM32 `Inc/eeprom.h`.
 * The CAN block occupies bytes 176-183 and is followed by `reserved[8]` at
 * 184-191.
 *
 * This replaces the old `Mcu.LAYOUT_SIZE` of 0xB8 (184), which stopped eight
 * bytes short of the struct so that the last field overran the buffer. That
 * truncation is the root of audit item A in issue #3.
 */
export const EEPROM_SIZE = 192;

export interface EepromField {
    offset: number;
    size: number;
    minEepromVersion?: number;
    maxEepromVersion?: number;
}

export type EepromLayoutField = {
    [key: string]: EepromField;
}

export const EepromLayout = {
    BOOT_BYTE: {
        offset: 0x00,
        size: 1
    },
    LAYOUT_REVISION: {
        offset: 0x01,
        size: 1
    },
    BOOT_LOADER_REVISION: {
        offset: 0x02,
        size: 1
    },
    MAIN_REVISION: {
        offset: 0x03,
        size: 1
    },
    SUB_REVISION: {
        offset: 0x04,
        size: 1
    },
    MAX_RAMP: {
        offset: 0x05,
        size: 1,
        minEepromVersion: 3
    },
    MINIMUM_DUTY_CYCLE: {
        offset: 0x06,
        size: 1,
        minEepromVersion: 3
    },
    DISABLE_STICK_CALIBRATION: {
        offset: 0x07,
        size: 1,
        minEepromVersion: 3
    },
    ABSOLUTE_VOLTAGE_CUTOFF: {
        offset: 0x08,
        size: 1,
        minEepromVersion: 3
    },
    CURRENT_P: {
        offset: 0x09,
        size: 1,
        minEepromVersion: 3
    },
    CURRENT_I: {
        offset: 0x0A,
        size: 1,
        minEepromVersion: 3
    },
    CURRENT_D: {
        offset: 0x0B,
        size: 1,
        minEepromVersion: 3
    },
    ACTIVE_BRAKE_POWER: {
        offset: 0x0C,
        size: 1,
        minEepromVersion: 3
    },
    MOTOR_DIRECTION: {
        offset: 0x11,
        size: 1
    },
    BIDIRECTIONAL_MODE: {
        offset: 0x12,
        size: 1
    },
    SINUSOIDAL_STARTUP: {
        offset: 0x13,
        size: 1
    },
    COMPLEMENTARY_PWM: {
        offset: 0x14,
        size: 1
    },
    VARIABLE_PWM_FREQUENCY: {
        offset: 0x15,
        size: 1
    },
    STUCK_ROTOR_PROTECTION: {
        offset: 0x16,
        size: 1
    },
    TIMING_ADVANCE: {
        offset: 0x17,
        size: 1
    },
    PWM_FREQUENCY: {
        offset: 0x18,
        size: 1
    },
    STARTUP_POWER: {
        offset: 0x19,
        size: 1
    },
    MOTOR_KV: {
        offset: 0x1A,
        size: 1
    },
    MOTOR_POLES: {
        offset: 0x1B,
        size: 1
    },
    BRAKE_ON_STOP: {
        offset: 0x1C,
        size: 1
    },
    STALL_PROTECTION: {
        offset: 0x1D,
        size: 1
    },
    BEEP_VOLUME: {
        offset: 0x1E,
        size: 1
    },
    INTERVAL_TELEMETRY: {
        offset: 0x1F,
        size: 1
    },
    SERVO_LOW_THRESHOLD: {
        offset: 0x20,
        size: 1
    },
    SERVO_HIGH_THRESHOLD: {
        offset: 0x21,
        size: 1
    },
    SERVO_NEUTRAL: {
        offset: 0x22,
        size: 1
    },
    SERVO_DEAD_BAND: {
        offset: 0x23,
        size: 1
    },
    LOW_VOLTAGE_CUTOFF: {
        offset: 0x24,
        size: 1
    },
    LOW_VOLTAGE_THRESHOLD: {
        offset: 0x25,
        size: 1
    },
    RC_CAR_REVERSING: {
        offset: 0x26,
        size: 1
    },
    USE_HALL_SENSORS: {
        offset: 0x27,
        size: 1
    },
    SINE_MODE_RANGE: {
        offset: 0x28,
        size: 1
    },
    BRAKE_STRENGTH: {
        offset: 0x29,
        size: 1
    },
    RUNNING_BRAKE_LEVEL: {
        offset: 0x2A,
        size: 1
    },
    TEMPERATURE_LIMIT: {
        offset: 0x2B,
        size: 1
    },
    CURRENT_LIMIT: {
        offset: 0x2C,
        size: 1
    },
    SINE_MODE_POWER: {
        offset: 0x2D,
        size: 1
    },
    ESC_PROTOCOL: {
        offset: 0x2E,
        size: 1
    },
    AUTO_ADVANCE: {
        offset: 0x2F,
        size: 1
    },
    STARTUP_MELODY: {
        offset: 0x30,
        size: 128
    },
    /**
     * The 16-byte `can` struct at 0xB0. Bytes 176-183 are the eight live CAN
     * fields (`can_node`, `esc_index`, `require_arming`, `telem_rate`,
     * `require_zero_throttle`, `filter_hz`, `debug_rate`, `term_enable`);
     * 184-191 are `reserved[8]`.
     *
     * This is an opaque byte blob to the configurator: it is carried through
     * decode/encode untouched. It must never be routed through a string --
     * `can_node = 0x20` is a space, which `.trim()` deleted, and
     * `filter_hz = 0xC8` is invalid UTF-8, which decoded to U+FFFD. That is
     * audit item A.
     */
    CAN_SETTINGS: {
        offset: 0xB0,
        size: 16
    }
} satisfies EepromLayoutField;

export type EepromLayoutKeys = keyof typeof EepromLayout;
export type EepromLayoutValues = typeof EepromLayout[EepromLayoutKeys];

/**
 * A decoded settings object.
 *
 * One entry per layout field that is present at the ESC's layout revision.
 * Single-byte fields are plain numbers; `STARTUP_MELODY` is a `number[]` (what
 * the RTTTL editor produces); every other multi-byte field -- today only
 * `CAN_SETTINGS` -- is an opaque `Uint8Array`.
 *
 * Note there is deliberately no `string` in this union. Strings are how the CAN
 * block was being corrupted.
 */
export type McuSettings = {
    [key in EepromLayoutKeys as string]: number | number[] | Uint8Array;
};

/** Alias used by the newer core APIs; identical to {@link McuSettings}. */
export type EscSettings = McuSettings;

/**
 * Fields decoded as `number[]` rather than `Uint8Array`.
 *
 * Only the startup melody, because the RTTTL editor in the app round-trips it
 * through `Array.from()` and Vue's reactivity is happier with a plain array.
 * Encoding accepts either representation for any multi-byte field.
 */
export const NUMBER_ARRAY_FIELDS: ReadonlySet<string> = new Set(['STARTUP_MELODY']);
