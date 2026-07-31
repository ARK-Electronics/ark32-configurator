/**
 * Everything `run()` needs from outside itself, as one injected object.
 *
 * The reason it is an interface and not a set of imports: `run()` is the whole
 * CLI, and it has to be testable end to end -- every command, every exit code,
 * against the simulator, with no filesystem and no serial port. So the two things
 * that cannot be faked out of existence, the filesystem and the hardware
 * transport, come in through here. `node-env.ts` is the only file that binds them
 * to `node:fs` and `am32-node`.
 *
 * Note what is *not* here: the simulator. `--sim` builds its own rig inside
 * `sim.ts`, because the point of `--sim` is that the CLI's simulated path and the
 * test suite's rig are the same object graph (issue #3 section 3). Injecting the
 * simulator would let a test hand `run()` something the real `--sim` never
 * builds, which is exactly the divergence `--sim` exists to prevent.
 */

import type { Transport } from 'am32-core/transport';
import type { NodePortInfo } from 'am32-node/serialport-types';

export interface OpenPortRequest {
    path: string
    baudRate: number
    onError?: (error: Error) => void
    log?: (message: string) => void
}

/** One HTTPS response, body already read. */
export interface HttpResponse {
    status: number
    body: string
}

/** Where `releases` and `flash --release` look for firmware. */
export interface FirmwareSource {
    owner: string
    repo: string
    /** Sent as a bearer token when set. GitHub's anonymous rate limit is 60/hr. */
    token: string | null
}

export interface CliEnv {
    /** Command output. One trailing newline per call is the caller's job. */
    stdout(text: string): void
    /** Diagnostics: session logs, progress, warnings. Never machine-read. */
    stderr(text: string): void

    readFile(path: string): Promise<Uint8Array>
    readTextFile(path: string): Promise<string>
    writeFile(path: string, data: Uint8Array): Promise<void>
    /** `mkdir -p`. */
    ensureDir(path: string): Promise<void>
    joinPath(...parts: string[]): string

    /** Opens a real serial port. Rejects when `serialport` cannot be loaded. */
    openPort(request: OpenPortRequest): Promise<Transport>
    /** Every serial port the OS knows about, unfiltered. */
    listPorts(): Promise<NodePortInfo[]>

    /**
     * One HTTPS GET, redirects followed, body read to a string. Rejects only
     * when the network itself failed; an HTTP error status is a response.
     * Injected for the same reason the filesystem is: `releases` and
     * `flash --release` have to be testable with no network at all.
     */
    httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse>

    /**
     * The firmware release repo, resolved by the entry point from
     * `GITHUB_FIRMWARE_OWNER` / `GITHUB_FIRMWARE_REPO` / `GITHUB_TOKEN` (or
     * `GH_TOKEN`) -- the same variables the web app's server honours.
     */
    firmware: FirmwareSource

    /** Printed by `--version`. */
    version: string
}
