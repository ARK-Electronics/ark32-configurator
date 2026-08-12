/**
 * User-facing cheat sheet for every EEPROM field, in layout order.
 *
 * Units and labels match what the configurator shows, not the raw byte.
 * ARK defaults are the ARK 4IN1 factory image
 * (`ARK32/factory/ARK_4IN1_F051_eeprom_defaults.json`).
 *
 * Keep the prose in lockstep with `ARK32/doc/eeprom-settings.md`.
 */

import { EepromLayout, type EepromLayoutKeys } from './layout';

export interface SettingGuideEntry {
    field: EepromLayoutKeys
    name: string
    range: string
    arkDefault: string
    /** 1–3 sentences. Field tooltip and cheat-sheet body. */
    help: string
}

export const SETTING_GUIDE: readonly SettingGuideEntry[] = [
    {
        field: 'BOOT_BYTE',
        name: 'Boot byte',
        range: '0x00 / 0x01 / 0xFF',
        arkDefault: '0x01',
        help: 'Bootloader jump flag. 0x01 or 0xFF runs the application. Owned by the flash/boot path, not a user setting.'
    },
    {
        field: 'LAYOUT_REVISION',
        name: 'EEPROM layout',
        range: 'integer (current is 3)',
        arkDefault: '3',
        help: 'Which EEPROM layout the firmware expects. The firmware migrates older layouts on boot. Do not write this by hand.'
    },
    {
        field: 'BOOT_LOADER_REVISION',
        name: 'Bootloader revision',
        range: 'integer',
        arkDefault: 'stamped by the bootloader',
        help: 'Bootloader version. The bootloader overwrites this on every settings-page write, so changing it does nothing.'
    },
    {
        field: 'MAIN_REVISION',
        name: 'Firmware major',
        range: 'integer',
        arkDefault: 'from the running firmware',
        help: 'Firmware major version, rewritten on boot. Not a setting.'
    },
    {
        field: 'SUB_REVISION',
        name: 'Firmware minor',
        range: 'integer',
        arkDefault: 'from the running firmware',
        help: 'Firmware minor version, rewritten on boot. Not a setting.'
    },
    {
        field: 'MAX_RAMP',
        name: 'Ramp rate',
        range: '0.1–20 % duty / ms',
        arkDefault: '2.0 %/ms',
        help: 'How fast duty may change, as a percent of full throttle per millisecond. 2 %/ms means 0→100% takes 50 ms; lower is safer on large props, and values under 1.0 use a finer 0.1 %/ms step. Firmware also caps each rpm band, so this setting only lowers that cap.'
    },
    {
        field: 'MINIMUM_DUTY_CYCLE',
        name: 'Minimum duty cycle',
        range: '0–25%',
        arkDefault: '2%',
        help: 'Lowest motor duty the ESC will apply once spinning, on DShot and servo alike. Raise if the motor will not start or growls at idle. Too high wastes hover power.'
    },
    {
        field: 'DISABLE_STICK_CALIBRATION',
        name: 'Disable stick calibration',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Skips the PWM high/low stick calibration on boot. Irrelevant for DShot.'
    },
    {
        field: 'ABSOLUTE_VOLTAGE_CUTOFF',
        name: 'Absolute voltage cutoff',
        range: '0.5–50 V (0.5 V steps)',
        arkDefault: '5.0 V',
        help: 'Pack voltage that Absolute LVC treats as empty. Unused unless Low voltage cut off is Absolute.'
    },
    {
        field: 'CURRENT_P',
        name: 'Current P',
        range: '0–255',
        arkDefault: '100',
        help: 'Proportional gain of the current limiter. Only runs when a current limit is set. Leave the factory value unless you are tuning the limiter.'
    },
    {
        field: 'CURRENT_I',
        name: 'Current I',
        range: '0–255',
        arkDefault: '0',
        help: 'Integral gain of the current limiter. Leave at 0 unless the limit is oscillating or sagging.'
    },
    {
        field: 'CURRENT_D',
        name: 'Current D',
        range: '0–255',
        arkDefault: '50',
        help: 'Derivative gain of the current limiter. Damps overshoot when current hits the cap.'
    },
    {
        field: 'ACTIVE_BRAKE_POWER',
        name: 'Active brake power',
        range: '0–5% duty (0 is off)',
        arkDefault: '2%',
        help: 'Duty applied in Active brake mode. Unused unless Brake on stop is Active brake.'
    },
    {
        field: 'MOTOR_DIRECTION',
        name: 'Reversed',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Swaps rotation direction. Same as the Reversed checkbox on each ESC card.'
    },
    {
        field: 'BIDIRECTIONAL_MODE',
        name: '3D mode',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Center throttle is stop; above is forward, below is reverse. For 3D planes, not multirotors.'
    },
    {
        field: 'SINUSOIDAL_STARTUP',
        name: 'Sinusoidal startup',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Open-loop sine drive at the start of spool-up, smoother on large, high-inertia motors. Requires Complementary PWM. ARK 4IN1 ships this off; the feature is still available.'
    },
    {
        field: 'COMPLEMENTARY_PWM',
        name: 'Complementary PWM',
        range: 'Off / On',
        arkDefault: 'On',
        help: 'Drives the low-side FETs during the off time (active freewheeling). More efficient, and required for sine start and braking. Leave on for multirotors.'
    },
    {
        field: 'VARIABLE_PWM_FREQUENCY',
        name: 'PWM type',
        range: 'Fixed / Variable / By RPM',
        arkDefault: 'Variable',
        help: 'Fixed uses the kHz setting. Variable sweeps that setting up to 2× as rpm rises. By RPM picks frequency from commutation speed and ignores the kHz slider.'
    },
    {
        field: 'STUCK_ROTOR_PROTECTION',
        name: 'Stuck rotor protection',
        range: 'Off / On',
        arkDefault: 'On',
        help: 'Cuts drive if the motor never produces BEMF (jammed or missing prop). Leave on.'
    },
    {
        field: 'TIMING_ADVANCE',
        name: 'Timing advance',
        range: '0–30° (0.9375° steps)',
        arkDefault: '15°',
        help: 'How early the ESC commutates relative to the BEMF zero-cross. More advance can make more power and heat; too much desyncs. Ignored while Auto timing advance is on.'
    },
    {
        field: 'PWM_FREQUENCY',
        name: 'PWM frequency',
        range: '8–144 kHz',
        arkDefault: '24 kHz',
        help: 'FET switching rate when PWM Type is Fixed or Variable. Higher is quieter and costs more heat. Ignored when PWM Type is By RPM.'
    },
    {
        field: 'STARTUP_POWER',
        name: 'Startup power',
        range: '50–150%',
        arkDefault: '100%',
        help: 'Extra duty added on top of Minimum duty cycle during startup. Raise if the motor will not break out; lower if it lurches or overshoots.'
    },
    {
        field: 'MOTOR_KV',
        name: 'Motor KV',
        range: '20–10220 (40 kV steps)',
        arkDefault: '1020',
        help: 'Nameplate kV. Used for the low-rpm throttle envelope and for auto timing. Wrong kV can cap top end or make timing too aggressive.'
    },
    {
        field: 'MOTOR_POLES',
        name: 'Motor poles',
        range: '2–64',
        arkDefault: '14',
        help: 'Magnet count, usually 14. Scales rpm telemetry and the same envelope/timing math as Motor KV.'
    },
    {
        field: 'BRAKE_ON_STOP',
        name: 'Brake on stop',
        range: 'Off / Brake on stop / Active brake',
        arkDefault: 'Off',
        help: 'Off coasts at zero throttle; Brake on stop shorts the windings (drag brake). Active brake applies a small reverse duty and only runs while armed. Leave off for multirotors.'
    },
    {
        field: 'STALL_PROTECTION',
        name: 'Stall protection',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Boosts throttle as rpm falls, for crawlers and RC cars. Do not use on multirotors.'
    },
    {
        field: 'BEEP_VOLUME',
        name: 'Beeper volume',
        range: '0–11',
        arkDefault: '5',
        help: 'Loudness of motor-as-speaker beeps. 0 is effectively silent. Beeps only play when the motor is not spinning.'
    },
    {
        field: 'INTERVAL_TELEMETRY',
        name: '30 ms interval telemetry',
        range: 'Off / On (values >1 stagger the interval)',
        arkDefault: 'Off',
        help: 'Sends KISS telemetry on a ~30 ms cadence over the signal wire. Values above 1 offset the interval so several ESCs can share one wire.'
    },
    {
        field: 'SERVO_LOW_THRESHOLD',
        name: 'Low threshold',
        range: '750–1250 µs',
        arkDefault: '1020 µs',
        help: 'PWM pulse treated as zero throttle. Ignored under DShot.'
    },
    {
        field: 'SERVO_HIGH_THRESHOLD',
        name: 'High threshold',
        range: '1750–2250 µs',
        arkDefault: '1980 µs',
        help: 'PWM pulse treated as full throttle. Ignored under DShot.'
    },
    {
        field: 'SERVO_NEUTRAL',
        name: 'Neutral',
        range: '1374–1630 µs',
        arkDefault: '1500 µs',
        help: 'Center pulse for bidirectional / 3D PWM. Ignored under DShot and in unidirectional mode.'
    },
    {
        field: 'SERVO_DEAD_BAND',
        name: 'Dead band',
        range: '0–100',
        arkDefault: '50',
        help: 'PWM counts around Neutral treated as stop, so stick jitter does not spin the motor.'
    },
    {
        field: 'LOW_VOLTAGE_CUTOFF',
        name: 'Low voltage cut off',
        range: 'Off / Cell based / Absolute',
        arkDefault: 'Off',
        help: 'Off does nothing. Cell based estimates cell count and cuts at the per-cell threshold; Absolute cuts at the voltage set below. Prefer the flight controller for LVC on a multirotor.'
    },
    {
        field: 'LOW_VOLTAGE_THRESHOLD',
        name: 'Low voltage cut off threshold',
        range: '2.50–3.50 V/cell',
        arkDefault: '3.00 V/cell',
        help: 'Per-cell voltage that Cell based LVC treats as empty. Unused when LVC is Off or Absolute.'
    },
    {
        field: 'RC_CAR_REVERSING',
        name: 'Car type reverse braking',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Car-style brake-then-reverse on the same stick. Not for multirotors.'
    },
    {
        field: 'USE_HALL_SENSORS',
        name: 'Use hall sensors',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Sensored commutation. Only works on firmware built with hall-sensor support. ARK 4IN1 has none, so this is forced off.'
    },
    {
        field: 'SINE_MODE_RANGE',
        name: 'Sine mode range',
        range: '5–25% throttle',
        arkDefault: '15%',
        help: 'Throttle percent where sine mode hands off to normal BEMF commutation.'
    },
    {
        field: 'BRAKE_STRENGTH',
        name: 'Brake strength',
        range: '1–10',
        arkDefault: '10',
        help: 'How hard the stopped drag brake holds. Only used when Brake on stop is on.'
    },
    {
        field: 'RUNNING_BRAKE_LEVEL',
        name: 'Running brake level',
        range: '1–10',
        arkDefault: '10',
        help: 'Regen / dead-time while spinning. Lower is more braking and more FET heat. 10 is the least brake.'
    },
    {
        field: 'TEMPERATURE_LIMIT',
        name: 'Temperature limit',
        range: '70–140 °C (141+ is off)',
        arkDefault: 'Off',
        help: 'Starts folding duty back as FET temperature approaches this. The top of the slider disables it.'
    },
    {
        field: 'CURRENT_LIMIT',
        name: 'Current limit',
        range: '0–200 A (top of slider is off)',
        arkDefault: 'Off',
        help: 'Caps phase current using the onboard shunt and the Current P/I/D terms. The top of the slider disables it. ARK 4IN1 shares one shunt across four ESCs, so this is not a per-motor limiter.'
    },
    {
        field: 'SINE_MODE_POWER',
        name: 'Sine mode power',
        range: '1–10',
        arkDefault: '6',
        help: 'How hard sine mode drives. Raise if the motor will not break out in sine; lower if it jerks at the handoff.'
    },
    {
        field: 'ESC_PROTOCOL',
        name: 'Protocol',
        range: 'Auto, DShot, Servo, Serial, EDT ARM',
        arkDefault: 'DShot',
        help: 'Which throttle input to accept. Auto detects DShot vs servo PWM; DShot is what ARK ships. EDT ARM requires an Extended DShot Telemetry arm handshake before it will spin.'
    },
    {
        field: 'AUTO_ADVANCE',
        name: 'Auto timing advance',
        range: 'Off / On',
        arkDefault: 'Off',
        help: 'Picks timing from rpm (using Motor KV and poles) as the motor spins up. Overrides the Timing advance slider.'
    },
    {
        field: 'STARTUP_MELODY',
        name: 'Startup melody',
        range: 'Bluejay RTTTL, 128 bytes',
        arkDefault: 'ARK tune (erased / 0xFF)',
        help: 'Tune played on the motor at boot. All 0xFF plays the ARK “ARK” Morse tune. Only plays while the motor is not spinning.'
    },
    {
        field: 'CAN_SETTINGS',
        name: 'CAN settings',
        range: '16 bytes at offset 176',
        arkDefault: 'zeros (node 0, index 0)',
        help: 'DroneCAN identity and options: node ID, ESC index, require-arming, telemetry rate, require-zero-throttle, input filter, debug rate, bus terminator. The configurator carries this block through every save and does not edit it. Reset-to-defaults also leaves it alone so four ESCs do not collapse onto one node ID.'
    }
];

const BY_FIELD: ReadonlyMap<string, SettingGuideEntry> = new Map(
    SETTING_GUIDE.map(entry => [entry.field, entry])
);

/** Look up the cheat-sheet row for a layout field. */
export function settingGuide (field: string): SettingGuideEntry | undefined {
    return BY_FIELD.get(field);
}

/** First-sentence tooltip text, or undefined when the field has no guide row. */
export function settingHelp (field: string): string | undefined {
    return BY_FIELD.get(field)?.help;
}

/** Layout keys that have no guide row. Empty when the catalog is complete. */
export function missingGuideFields (): string[] {
    return Object.keys(EepromLayout).filter(field => !BY_FIELD.has(field));
}
