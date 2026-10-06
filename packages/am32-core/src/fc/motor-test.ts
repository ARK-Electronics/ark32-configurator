/**
 * The keepalive half of the motor test: `MSP_SET_MOTOR` carrying every
 * channel's throttle, resent for as long as the test runs, and the lock that
 * holds the throttle at zero until a client unlocks it.
 *
 * Betaflight has no timeout on `MSP_SET_MOTOR`: `motor_disarmed[]` keeps the
 * last value until another frame or a reboot (msp.c:3308-3315,
 * mixer_init.c:505-510). So the stream is how the host notices a dead link.
 * A failed frame zeroes and relocks every motor, and the stream carries on
 * sending stops: a motor the FC is still driving stops only when one lands.
 *
 * Mode switching -- leaving passthrough, waiting for the ESCs to arm, the
 * reverse-direction round trip -- belongs to `Am32Session`, which owns
 * passthrough. This class only sends between `begin`/`resume` and
 * `suspend`/`end`, which the session brackets around the times MSP is safe.
 */

import type { Clock, ClockTimer } from '../clock';
import { SessionError, describeError } from '../errors';
import type { LogLevel, MotorTestPhase, MotorTestStatus } from '../events';
import { MSP_COMMANDS } from '../framing/msp';
import type { MspSession } from './msp-session';

/** Full throttle. Zero is stopped. */
export const MOTOR_THROTTLE_MAX = 1000;

/** `MSP_SET_MOTOR` value of a stopped motor; full throttle is this plus 1000. */
const MSP_MOTOR_STOP = 1000;

/**
 * Values in every `MSP_SET_MOTOR`, stopped past the motor count. Betaflight
 * answers an error unless there is one per motor, and reads no more
 * (msp.c:3308-3315); its own configurator always sends eight.
 */
const MSP_MOTOR_SLOTS = 8;

/** Gap between `MSP_SET_MOTOR` frames while nothing changes. */
export const MOTOR_KEEPALIVE_MS = 100;

/**
 * Gap between stop frames while the FC is not answering. Each failure is
 * logged by the link, and a closed port fails at once.
 */
const UNANSWERED_RETRY_MS = 1000;

export interface MotorTestOptions {
    msp: MspSession
    clock: Clock
    emit: (status: MotorTestStatus) => void
    log: (level: LogLevel, message: string) => void
    keepaliveMs?: number
}

export class MotorTest {
    private readonly msp: MspSession;
    private readonly clock: Clock;
    private readonly emitStatus: (status: MotorTestStatus) => void;
    private readonly log: (level: LogLevel, message: string) => void;
    private readonly keepaliveMs: number;

    private phaseValue: MotorTestPhase = 'off';
    private unlocked = false;
    private throttle: number[] = [];
    private target: number | undefined;
    private error: string | undefined;
    /** The last `MSP_SET_MOTOR` was answered. */
    private responding = true;

    private sending = false;
    private timer: ClockTimer | null = null;
    /** The exchange loop in flight, if any. */
    private current: Promise<void> | null = null;
    /** Something changed during an exchange; send again when it ends. */
    private resend = false;
    /** Bumped by every halt or failure, so a wait that outlived its run can tell. */
    private generation = 0;
    private wake: (() => void) | null = null;

    constructor (options: MotorTestOptions) {
        this.msp = options.msp;
        this.clock = options.clock;
        this.emitStatus = options.emit;
        this.log = options.log;
        this.keepaliveMs = Math.max(1, options.keepaliveMs ?? MOTOR_KEEPALIVE_MS);
    }

    get status (): MotorTestStatus {
        const status: MotorTestStatus = {
            phase: this.phaseValue,
            unlocked: this.unlocked,
            responding: this.responding,
            throttle: [...this.throttle]
        };
        if (this.target !== undefined) { status.target = this.target; }
        if (this.error !== undefined) { status.error = this.error; }
        return status;
    }

    get phase (): MotorTestPhase {
        return this.phaseValue;
    }

    get channels (): number {
        return this.throttle.length;
    }

    /** Token for the current run, for {@link isCurrent} after an await. */
    get run (): number {
        return this.generation;
    }

    isCurrent (run: number): boolean {
        return run === this.generation && this.phaseValue !== 'off';
    }

    /** Start sending stopped motors for `count` channels, locked. */
    begin (count: number): number {
        this.generation += 1;
        this.throttle = new Array<number>(count).fill(0);
        this.unlocked = false;
        this.target = undefined;
        this.error = undefined;
        this.responding = true;
        this.phaseValue = 'starting';
        this.startSending();
        this.emit();
        return this.generation;
    }

    /** The ESCs have had time to arm: throttle is accepted once unlocked. */
    ready (): void {
        this.phaseValue = 'ready';
        this.emit();
    }

    /** Sleep `ms`, cut short if the run ends. Resolves true if it is still current. */
    async wait (ms: number, run: number): Promise<boolean> {
        if (this.isCurrent(run)) {
            await new Promise<void>((resolve) => {
                const timer = this.clock.setTimeout(() => {
                    this.wake = null;
                    resolve();
                }, ms);
                this.wake = () => {
                    timer.cancel();
                    this.wake = null;
                    resolve();
                };
            });
        }
        return this.isCurrent(run);
    }

    /** Accept throttle. Refused until ready, and while the FC is not answering. */
    unlock (): void {
        if (this.phaseValue !== 'ready') {
            throw new SessionError('motor-test', `the motor test is ${this.phaseValue}, not ready to unlock`);
        }
        if (!this.responding) {
            throw new SessionError('motor-test', `the flight controller is not answering: ${this.error ?? 'MSP_SET_MOTOR failed'}`);
        }
        this.unlocked = true;
        this.error = undefined;
        this.emit();
    }

    /**
     * One channel's throttle, 0 to {@link MOTOR_THROTTLE_MAX}. Refused unless
     * ready and unlocked, so a slider event that lands after a stop cannot
     * start a motor.
     */
    setThrottle (target: number, throttle: number): void {
        this.requireUnlocked();
        if (!Number.isInteger(target) || target < 0 || target >= this.throttle.length) {
            throw new SessionError('motor-test', `there is no ESC ${target + 1}; the FC reports ${this.throttle.length}`);
        }
        this.throttle[target] = clampThrottle(throttle);
        this.emit();
        this.kick();
    }

    setAllThrottle (throttle: number): void {
        this.requireUnlocked();
        this.throttle.fill(clampThrottle(throttle));
        this.emit();
        this.kick();
    }

    /** Every motor to zero and relock, with the frame sent straight away. */
    stop (): void {
        const changed = this.unlocked || this.throttle.some(value => value !== 0);
        this.throttle.fill(0);
        this.unlocked = false;
        if (changed && this.phaseValue !== 'off') {
            this.emit();
        }
        this.kick();
    }

    /**
     * Stop the motors, wait for that frame, and go quiet so the session can
     * use 4-way. The phase reads `reversing` for `target` until {@link resume}.
     */
    async suspend (target: number): Promise<void> {
        this.stop();
        await this.flush();
        this.stopSending();
        this.phaseValue = 'reversing';
        this.target = target;
        this.emit();
    }

    /** Back to sending stopped motors after a {@link suspend}, still locked. */
    resume (): void {
        this.phaseValue = 'starting';
        this.target = undefined;
        this.startSending();
        this.emit();
    }

    /** End the current run now: motors to zero, any wait cut short. */
    halt (): void {
        this.generation += 1;
        this.wake?.();
        this.stop();
    }

    /** Send a last stop frame if still sending, then go quiet. Never throws. */
    async end (): Promise<void> {
        if (this.phaseValue === 'off') {
            return;
        }
        this.halt();
        await this.flush();
        this.stopSending();
        this.phaseValue = 'off';
        this.target = undefined;
        this.emit();
    }

    // ---- keepalive ---------------------------------------------------------

    private startSending (): void {
        this.sending = true;
        this.kick();
    }

    private stopSending (): void {
        this.sending = false;
        this.timer?.cancel();
        this.timer = null;
    }

    /** Send now, or as soon as the exchange in flight ends. */
    private kick (): void {
        if (!this.sending) {
            return;
        }
        if (this.current) {
            this.resend = true;
            return;
        }
        this.timer?.cancel();
        this.timer = null;
        this.current = this.exchange().finally(() => {
            this.current = null;
            if (this.sending) {
                this.timer = this.clock.setTimeout(() => {
                    this.timer = null;
                    this.kick();
                }, this.responding ? this.keepaliveMs : UNANSWERED_RETRY_MS);
            }
        });
    }

    private async exchange (): Promise<void> {
        do {
            this.resend = false;
            try {
                await this.msp.request(MSP_COMMANDS.MSP_SET_MOTOR, this.payload(), this.responding ? undefined : 1);
            } catch (error) {
                if (this.sending) {
                    this.failed(error);
                }
                return;
            }
            if (!this.responding) {
                this.responding = true;
                this.log('info', 'the flight controller is answering MSP_SET_MOTOR again');
                this.emit();
            }
        } while (this.sending && this.resend);
    }

    /** Wait until no exchange is in flight. */
    private async flush (): Promise<void> {
        while (this.current) {
            await this.current;
        }
    }

    /**
     * Zero and relock on the first failure. The keepalive keeps sending those
     * zeros, so a motor the FC is still driving stops once a frame lands.
     */
    private failed (error: unknown): void {
        if (!this.responding) {
            return;
        }
        this.responding = false;
        this.error = `MSP_SET_MOTOR failed, so every motor was stopped and locked: ${describeError(error)}`;
        this.log('error', this.error);
        this.throttle.fill(0);
        this.unlocked = false;
        this.emit();
    }

    private payload (): Uint8Array {
        const slots = Math.max(MSP_MOTOR_SLOTS, this.throttle.length);
        const bytes = new Uint8Array(slots * 2);
        for (let i = 0; i < slots; i += 1) {
            const value = MSP_MOTOR_STOP + (this.unlocked ? (this.throttle[i] ?? 0) : 0);
            bytes[i * 2] = value & 0xFF;
            bytes[i * 2 + 1] = (value >> 8) & 0xFF;
        }
        return bytes;
    }

    private requireUnlocked (): void {
        if (this.phaseValue !== 'ready' || !this.unlocked) {
            throw new SessionError(
                'motor-test',
                this.phaseValue === 'ready'
                    ? 'the motors are locked; unlock them first'
                    : `the motor test is ${this.phaseValue}, not ready`
            );
        }
    }

    private emit (): void {
        this.emitStatus(this.status);
    }
}

function clampThrottle (value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(MOTOR_THROTTLE_MAX, Math.max(0, Math.round(value)));
}
