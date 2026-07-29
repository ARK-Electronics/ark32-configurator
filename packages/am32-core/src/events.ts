/**
 * The session's typed event emitter.
 *
 * Issue #3 section 2 lists four channels -- `log`, `progress`, `esc`, `state` --
 * and they exist so the UI and the CLI can render the same run without either
 * one reaching below {@link import('./session').Am32Session} for it. The Vue app
 * mirrors these into its pinia stores (block 5); block 7's `-v` prints them.
 *
 * Deliberately not an `EventTarget` or a Node `EventEmitter`: the core tsconfig
 * has no `dom` lib and `types: []`, so neither name exists here. That constraint
 * is the point -- see `packages/am32-core/tsconfig.json`.
 */

import type { McuInfo } from './mcu';

export type LogLevel = 'info' | 'warn' | 'error';

/** Where a session is in its lifecycle. Mirrors the store fields block 5 keeps. */
export type SessionState =
    /** Constructed, transport not open. */
    | 'idle'
    /** Probing for an FC: MSP identity, possibly the ArduPilot idle window. */
    | 'connecting'
    /** An FC has answered MSP. Not in passthrough. */
    | 'connected'
    /** In 4-way passthrough. MSP is unavailable on Betaflight while this holds. */
    | 'passthrough'
    /** Walking the ESC channels. */
    | 'enumerating'
    /** The transport is closed. Terminal. */
    | 'disconnected';

export interface LogEvent {
    level: LogLevel
    message: string
}

/**
 * A long operation's position. `total` is 0 when the length is not yet known
 * (an enumerate before the FC has said how many channels there are).
 */
export interface ProgressEvent {
    phase: 'connect' | 'passthrough' | 'enumerate' | 'read' | 'reset'
    current: number
    total: number
    /** Zero-based channel, when the phase is per-ESC. */
    target?: number
}

export interface EscEvent {
    /** Zero-based channel, as `cmd_DeviceInitFlash` numbers them. */
    target: number
    status: 'reading' | 'ok' | 'error'
    info?: McuInfo
    error?: string
}

export interface StateEvent {
    state: SessionState
    previous: SessionState
}

export interface SessionEvents {
    log: LogEvent
    progress: ProgressEvent
    esc: EscEvent
    state: StateEvent
}

export type SessionEventName = keyof SessionEvents;

export type SessionListener<K extends SessionEventName> = (event: SessionEvents[K]) => void;

/**
 * A minimal typed emitter.
 *
 * A listener that throws is reported through the `log` channel and otherwise
 * ignored: a component that blows up while rendering a progress tick must not
 * abort the flash that produced it. `log` listeners that throw are dropped
 * silently, because the alternative is an infinite regress.
 */
export class SessionEmitter {
    private readonly listeners = new Map<SessionEventName, Set<(event: never) => void>>();

    on<K extends SessionEventName> (event: K, listener: SessionListener<K>): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener as (event: never) => void);
        return () => {
            set?.delete(listener as (event: never) => void);
        };
    }

    /**
     * Drop every listener.
     *
     * Deliberately **not** called by `Am32Session.disconnect`: doing so would
     * swallow the final `state` event, which is the one a client most needs.
     * Subscribers own their unsubscribe functions; this is for a client tearing
     * everything down at once.
     */
    clear (): void {
        this.listeners.clear();
    }

    emit<K extends SessionEventName> (event: K, payload: SessionEvents[K]): void {
        const set = this.listeners.get(event);
        if (!set) {
            return;
        }
        for (const listener of [...set]) {
            try {
                (listener as SessionListener<K>)(payload);
            } catch (error) {
                if (event !== 'log') {
                    this.emit('log', {
                        level: 'warn',
                        message: `session: a ${event} listener threw: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    });
                }
            }
        }
    }
}
