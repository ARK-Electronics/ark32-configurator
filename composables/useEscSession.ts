/**
 * The app's entire protocol client.
 *
 * Block 5's job in issue #3: the Nuxt app becomes a thin client of `Am32Session`.
 * This file is the whole of "thin" -- it owns the session for the lifetime of a
 * connection, mirrors its four event channels into the pinia stores, and turns
 * each button into one session call plus a toast. Everything it deleted
 * (`src/communication/{serial,msp,four_way,commands.queue}.ts`) was a second
 * protocol stack that only the browser ran, which is exactly what the plan exists
 * to remove: the `ark32` CLI in block 7 drives the same session, so the two paths
 * cannot diverge.
 *
 * Three rules for anything added here:
 *
 *  1. **No protocol logic.** No frames, no timeouts, no retries, no `Link`. If
 *     you find yourself needing a millisecond number or a `FOUR_WAY_*` constant,
 *     it belongs in `am32-core`. The `no-restricted-imports` rule in
 *     `.eslintrc.json` enforces the framing/link half of this.
 *  2. **No `if (variant === 'ardupilot')`.** FC differences live in
 *     `am32-core/fc/quirks.ts`. The app does not know which flight controller it
 *     is talking to, beyond displaying the name.
 *  3. **Store writes go through the event mirror**, so the CLI's `-v` output and
 *     the UI are showing the same run. A store field the session cannot produce
 *     is a store field that will drift.
 */

import { decodeSettings } from 'am32-core/eeprom/codec';
import {
    Am32Session,
    SessionError,
    type EscResult,
    type EscSettings,
    type FlashOptions,
    type ProgressEvent
} from 'am32-core/session';
import type { EscData } from 'am32-core/mcu';
import { WebSerialTransport } from 'am32-web';

/**
 * The live session, outside the composable so every caller shares one.
 *
 * A holder rather than a bare `let` so the closures below always see the current
 * value. There is deliberately at most one: a `SerialPort` can only be opened
 * once, and two sessions over one port would each have their own mutex, which is
 * the race `Am32Session.exclusive` exists to prevent.
 */
const live: { session: Am32Session | null } = { session: null };

/** What the flash modal shows while each phase runs. */
const PHASE_LABELS: Record<ProgressEvent['phase'], string> = {
    connect: 'Connecting',
    passthrough: 'Passthrough',
    enumerate: 'Reading ESCs',
    read: 'Read ESC',
    reset: 'Resetting',
    write: 'Saving',
    // `progressIsIntermediate` in SerialDevice.vue keys the determinate progress
    // bar off this exact label, because this is the only phase that counts bytes.
    flash: 'Writing'
};

/** Phases that belong to one channel's long operation, so the modal can lock. */
const PER_TARGET_PHASES: ProgressEvent['phase'][] = ['flash', 'reset', 'read'];

export const useEscSession = () => {
    const serialStore = useSerialStore();
    const escStore = useEscStore();
    const logStore = useLogStore();
    const toast = useToast();

    const message = (error: unknown): string =>
        (error instanceof Error ? error.message : String(error));

    /** Log it, toast it, and hand the text back for the caller's own message. */
    const surface = (title: string, error: unknown): string => {
        const text = message(error);
        logStore.logError(text);
        toast.add({ title, color: 'red', description: text });
        return text;
    };

    const requireSession = (): Am32Session => {
        if (!live.session) {
            throw new SessionError('not-connected', 'not connected to a flight controller');
        }
        return live.session;
    };

    /** Grow `escData` so `target` is addressable, then hand that entry back. */
    const escEntry = (target: number): EscData => {
        while (escStore.escData.length <= target) {
            escStore.escData.push({ isLoading: false, isError: false } as EscData);
        }
        return escStore.escData[target];
    };

    const mirror = (session: Am32Session) => {
        session.on('log', (event) => {
            if (event.level === 'error') {
                logStore.logError(event.message);
            } else if (event.level === 'warn') {
                logStore.logWarning(event.message);
            } else {
                logStore.log(event.message);
            }
        });

        // The store's two connection flags are derived from the session's state
        // rather than set by hand at each call site, which is what kept them
        // disagreeing with the wire before: `isFourWay` was set true *before*
        // MSP_SET_PASSTHROUGH was known to have worked.
        session.on('state', (event) => {
            serialStore.hasConnection = ['connected', 'passthrough', 'enumerating'].includes(event.state);
            serialStore.isFourWay = event.state === 'passthrough' || event.state === 'enumerating';
        });

        session.on('esc', (event) => {
            const entry = escEntry(event.target);
            entry.isLoading = event.status === 'reading';
            entry.isError = event.status === 'error';
            if (event.info) {
                entry.data = event.info;
            }
        });

        session.on('progress', (event) => {
            escStore.step = PHASE_LABELS[event.phase];
            if (event.phase === 'flash') {
                escStore.totalBytes = event.total;
                escStore.bytesWritten = event.current;
            }
            if (event.target !== undefined && PER_TARGET_PHASES.includes(event.phase)) {
                escStore.activeTarget = event.target;
            }
        });
    };

    /**
     * Open `port` and identify the flight controller.
     *
     * The session opens the transport itself, probes MSP immediately and only
     * waits out ArduPilot's MAVLink window if it has to -- the 4.5 s the app used
     * to pay on every connect, Betaflight included, was audit item **H**.
     */
    const connect = async (port: SerialPort, baudRate: number): Promise<boolean> => {
        await disconnect({ quiet: true });

        const transport = new WebSerialTransport(port, {
            log: logStore.log,
            onError: (error: Error) => logStore.logError(`Serial read failed: ${error.message}`)
        });
        // The session opens the transport itself, so the baud rate the user picked
        // has to reach it here rather than at an `open()` call site.
        const session = new Am32Session({ transport, baudRate });
        mirror(session);
        live.session = session;

        try {
            const fc = await session.connect();
            serialStore.fc = fc;
            serialStore.port = port;
            return true;
        } catch (error) {
            // Leaving the port open would make every retry fail with "already in
            // use" until the tab is reloaded, so the failed session has to let go
            // of it before we drop the reference.
            await session.disconnect().catch(() => undefined);
            live.session = null;
            serialStore.$reset();

            if (error instanceof SessionError && error.reason === 'transport') {
                surface('Error', error);
                toast.add({
                    icon: 'i-material-symbols-mimo-disconnect-outline',
                    title: 'Error',
                    color: 'red',
                    description: 'Port already in use, please free device and try again!'
                });
            } else {
                surface('Could not talk to the flight controller', error);
            }
            return false;
        }
    };

    /** Leave passthrough, close the port and clear the stores. Safe to repeat. */
    const disconnect = async (options: { quiet?: boolean } = {}): Promise<void> => {
        const session = live.session;
        live.session = null;

        if (session) {
            await session.disconnect().catch((error: unknown) => {
                logStore.logError(`Disconnect: ${message(error)}`);
            });
        }

        serialStore.$reset();
        escStore.$reset();

        if (session && !options.quiet) {
            logStore.log('Connection to device closed');
        }
    };

    /** In 4-way passthrough, entering it if we are not there yet. */
    const ensurePassthrough = async (session: Am32Session): Promise<void> => {
        if (!session.inPassthrough) {
            await session.enterPassthrough();
        }
        escStore.expectedCount = session.escCount;
    };

    /**
     * Read every channel the FC reports.
     *
     * Per-channel results, never an exception for a channel that failed: that is
     * audit item **B**, where one dead ESC threw a `TypeError` out of the click
     * handler and took the other three with it. The store is filled by the
     * session's `esc` events as it goes, so the cards update per channel.
     */
    const readAll = async (): Promise<EscResult[]> => {
        escStore.escData = [];
        escStore.isLoading = true;

        try {
            // Inside the try, not above it: a click that arrives in the gap
            // between a disconnect and the store catching up would otherwise
            // throw straight out of the handler as an unhandled rejection.
            const session = requireSession();
            const results = await session.enumerate();
            escStore.expectedCount = session.escCount;

            const failed = results.filter(result => !result.ok);
            if (failed.length > 0) {
                toast.add({
                    title: 'Warning',
                    color: 'orange',
                    description: `${failed.length} of ${results.length} ESCs did not respond`
                });
            }
            return results;
        } catch (error) {
            surface('Could not read the ESCs', error);
            return [];
        } finally {
            escStore.isLoading = false;
            escStore.step = '';
        }
    };

    /**
     * Write every ESC whose settings the user has edited.
     *
     * One channel failing marks that card and carries on, for the same reason
     * `enumerate` does: a four-ESC board with one bad channel is a normal state,
     * not an exception.
     */
    const saveDirtySettings = async (): Promise<boolean> => {
        escStore.isSaving = true;
        let allWritten = true;

        try {
            const session = requireSession();
            await ensurePassthrough(session);

            for (let target = 0; target < escStore.escData.length; target += 1) {
                const entry = escStore.escData[target];
                if (entry.isError || !entry.data?.settingsDirty) {
                    continue;
                }

                try {
                    const result = await session.writeSettings(target, entry.data.settings);
                    // The image the session sent, which is what a later write
                    // starts from. Byte 2 is the one exception -- the bootloader
                    // stamps its own version over it inside every EEPROM write.
                    entry.data.settingsBuffer = result.image;
                    entry.data.settings = result.settings;
                    entry.data.settingsDirty = false;
                } catch (error) {
                    entry.isError = true;
                    allWritten = false;
                    surface('Save failed', error);
                }
            }
        } catch (error) {
            surface('Save failed', error);
            allWritten = false;
        } finally {
            escStore.isSaving = false;
            escStore.step = '';
        }

        return allWritten;
    };

    /** Stage `settings` on the given one-based ESC numbers, then write them. */
    const applySettings = async (settings: EscSettings, escNumbers: number[]): Promise<boolean> => {
        for (const n of escNumbers) {
            const entry = escStore.escData[n - 1];
            if (entry?.data) {
                entry.data.settings = { ...settings };
                entry.data.settingsDirty = true;
            }
        }
        return await saveDirtySettings();
    };

    /**
     * Flash `hex` to each of `targets` in turn.
     *
     * The `finally` is audit item **G**'s other half. `startFlash` had no
     * try/catch, so a rejection left `escStore.activeTarget > -1` -- which drives
     * `:prevent-close` on the flash modal, wedging the dialog open with no error
     * shown and no way out but a reload. Clearing the progress state here rather
     * than in the component makes it an invariant of the operation ("nothing is in
     * flight") instead of one call site's manners.
     */
    const flashTargets = async (
        hex: string,
        targets: number[],
        options: FlashOptions = {}
    ): Promise<boolean> => {
        try {
            const session = requireSession();
            await ensurePassthrough(session);

            for (const target of targets) {
                escStore.activeTarget = target;
                // The session clears the boot byte, streams the image, sets the
                // boot byte back, resets the ESC and re-reads it. A failure part
                // way leaves a board that comes up in its bootloader rather than
                // one running half an image.
                const info = await session.flash(target, hex, options);
                const entry = escEntry(target);
                entry.data = info;
                entry.isError = false;
                entry.isLoading = false;
            }
            return true;
        } catch (error) {
            surface('Flash failed', error);
            return false;
        } finally {
            escStore.activeTarget = -1;
            escStore.step = '';
            escStore.bytesWritten = 0;
            escStore.totalBytes = 0;
        }
    };

    /**
     * Decode a settings file the user picked, or a default image from the server.
     *
     * Here rather than in a component so `am32-core/eeprom/codec` has exactly one
     * caller in the app. A short file (the served defaults are 48 bytes) decodes
     * to the fields it actually contains and the rest of the ESC's image is left
     * alone by the write -- which is why *apply defaults* used to be the worst
     * offender for audit item **A**.
     */
    const decodeSettingsFile = (buffer: Uint8Array, layoutRevision: number): EscSettings =>
        decodeSettings(buffer, layoutRevision);

    return {
        connect,
        disconnect,
        readAll,
        saveDirtySettings,
        applySettings,
        flashTargets,
        decodeSettingsFile,
        get isConnected () {
            return live.session !== null;
        }
    };
};
