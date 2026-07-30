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
import type { Transport } from 'am32-core/transport';
import { listSerialPorts, openNodeTransport } from 'am32-node';
import type { NodePortInfo } from 'am32-node/serialport-types';
import type { CliEnv, OpenPortRequest } from './env';
import { VERSION } from './version';

export function createNodeEnv (): CliEnv {
    return {
        stdout: text => process.stdout.write(text),
        stderr: text => process.stderr.write(text),

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

        version: VERSION
    };
}
