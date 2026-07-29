import { useLogStore } from './../../stores/log';
import { MSP_COMMANDS, encodeMspCommand, isCompleteMspFrame, parseMspResponse } from 'am32-core/framing/msp';
import Serial from '~/src/communication/serial';

export interface MspResponse {
    commandName: number;
    data: DataView;
}

/**
 * Thin app-side wrapper over the core MSP framing.
 *
 * Block 1b moved encode/parse into `am32-core`; what is left here is the Serial
 * plumbing and the log-store wiring. Block 4 replaces the whole class with
 * `Am32Session`'s FC layer.
 */
export class Msp {
    // eslint-disable-next-line no-use-before-define
    static instance: Msp;

    static init (
        log: (s: string) => void,
        logWarning: (s: string) => void,
        logError: (s: string) => void
    ) {
        Msp.instance = new Msp(log, logWarning, logError);
    }

    static getInstance () {
        if (!Msp.instance) {
            useLogStore().logError('Msp instance missing!');
            throw new Error('Msp instance missing!');
        }
        return Msp.instance;
    }

    commandCount = 0;

    private readonly log: (s: string) => void;
    private readonly logError: (s: string) => void;

    constructor (
        log: (s: string) => void,
        _logWarning: (s: string) => void,
        logError: (s: string) => void
    ) {
        // logWarning is part of the init signature every communication class
        // shares; this one has nothing to warn about.
        this.log = log;
        this.logError = logError;
    }

    async send (command: MSP_COMMANDS, data?: Uint8Array): Promise<Uint8Array | null> {
        this.log(`Sending ${enumToString(command, MSP_COMMANDS)}...`);

        const frame = encodeMspCommand(command, data ?? new Uint8Array());

        try {
            return await Serial.write(frame.buffer as ArrayBuffer, undefined, isCompleteMspFrame);
        } catch (e: any) {
            this.logError(`MSP command failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Send `command` and return its reply.
     *
     * Rejects an MSP `!` error frame and any reply whose command field is not
     * the command we sent, instead of handing either back as data -- that was
     * audit item D.
     */
    async sendWithPromise (command: MSP_COMMANDS, data?: Uint8Array): Promise<MspResponse> {
        const result = await this.send(command, data);
        if (!result) {
            throw new Error('sendWithPromise: empty result');
        }

        const frame = parseMspResponse(result, { expectCommand: command });
        this.commandCount = Math.max(0, this.commandCount - 1);

        return {
            commandName: frame.command,
            data: new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
        };
    }

    getTypeMotorCommand (type: MspData['type']) {
        switch (type) {
        case 'inav':
            return MSP_COMMANDS.MSP_MOTOR;
        default:
            return MSP_COMMANDS.MSP_MOTOR_CONFIG;
        }
    }
}

export { MSP_COMMANDS };
export default Msp;
