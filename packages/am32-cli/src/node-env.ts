/**
 * The one file that binds `run()` to a real process.
 *
 * `node:fs` and `am32-node` are reached from here and nowhere else, which is what
 * lets `run.test.ts` drive every command with an in-memory filesystem and no
 * serial port.
 *
 * The interesting part is the error translation. `am32-node` reports "the native
 * module will not load" and "the OS refused to open that path" as plain errors,
 * because a transport should not know what an exit code is. But both mean the same
 * thing to a caller -- *the flight controller is not reachable, so nothing about
 * the ESCs is known* -- which is exit code 2. Wrapping them in
 * `SessionError('transport')` here is what makes `exitCodeForError` come to that
 * conclusion without a special case, and keeps the mapping in one table.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionError, describeError } from 'am32-core/errors';
import { DEFAULT_FIRMWARE_OWNER, DEFAULT_FIRMWARE_REPO } from 'am32-core/releases';
import type { Transport } from 'am32-core/transport';
import { listSerialPorts, openNodeTransport } from 'am32-node';
import type { NodePortInfo } from 'am32-node/serialport-types';
import type { CliEnv, OpenPortRequest } from './env';
import { VERSION } from './version';

/**
 * A writer that survives `ark32 ports | head`.
 *
 * Node does not die on SIGPIPE the way a C program does -- it turns the closed
 * pipe into an `EPIPE` write error instead. Unhandled, that propagates out of
 * `reporter.finish`, is caught by `run`'s catch-all and becomes **exit 1**: so
 * `ark32 get --esc 1 | head` would report a partial failure to a script under
 * `set -o pipefail`, for a pipeline that did exactly what was asked.
 *
 * Once the far end is gone there is nowhere to report anything, so a broken stream
 * becomes a silent no-op rather than an error to raise.
 */
function pipeSafeWriter (stream: NodeJS.WriteStream): (text: string) => void {
    let broken = false;
    stream.on('error', () => {
        broken = true;
    });

    return (text) => {
        if (broken) {
            return;
        }
        try {
            stream.write(text);
        } catch {
            broken = true;
        }
    };
}

export function createNodeEnv (): CliEnv {
    return {
        stdout: pipeSafeWriter(process.stdout),
        stderr: pipeSafeWriter(process.stderr),

        readFile: async (path) => {
            const buffer = await readFile(path);
            // A copy rather than a view: a Buffer is a view into a pooled
            // ArrayBuffer, and the codec slices its input.
            return Uint8Array.from(buffer);
        },
        readTextFile: path => readFile(path, 'utf8'),
        writeFile: (path, data) => writeFile(path, data),
        ensureDir: async (path) => {
            await mkdir(path, { recursive: true });
        },
        joinPath: (...parts) => join(...parts),

        openPort: async (request: OpenPortRequest): Promise<Transport> => {
            try {
                return await openNodeTransport({
                    path: request.path,
                    baudRate: request.baudRate,
                    onError: request.onError,
                    log: request.log
                });
            } catch (error) {
                throw new SessionError('transport', describeError(error), { cause: error });
            }
        },

        listPorts: async (): Promise<NodePortInfo[]> => {
            try {
                return await listSerialPorts();
            } catch (error) {
                throw new SessionError('transport', describeError(error), { cause: error });
            }
        },

        httpGet: async (url, headers) => {
            const response = await fetch(url, { headers, redirect: 'follow' });
            return { status: response.status, body: await response.text() };
        },

        firmware: {
            owner: process.env.GITHUB_FIRMWARE_OWNER || DEFAULT_FIRMWARE_OWNER,
            repo: process.env.GITHUB_FIRMWARE_REPO || DEFAULT_FIRMWARE_REPO,
            token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null
        },

        version: VERSION
    };
}
