// Web Serial globals (`navigator.serial`, `SerialPort`). These used to arrive
// as a side effect of importing `webserial-wrapper`, which depended on
// @types/dom-serial; block 2 deleted that package, so the reference has to be
// explicit. @types/dom-serial is now a direct devDependency.
/// <reference types="dom-serial" />

type LogMessageType = undefined | null | 'warning' | 'error'
type LogMessage = [Date, string, LogMessageType]

// Three types lived here for the app's own protocol classes: the MSP facts the
// FC reported, a log-callback alias and a promise-callback alias. Block 5 deleted
// all three with those classes (audit item I) -- what the FC reported is `FcInfo`
// from `am32-core/session` now, produced by the same code the CLI runs. The
// removed names are listed in `scripts/assert-deleted.sh`, which greps this file
// for them.

type SettingsType = 'select' | 'bool' | 'string' | 'number' | 'rtttl';
type SettingsSelectOptionsType = { label: string, value: number };

interface BlobFolderFile {
    name: string;
    url: string;
    downloadUrl?: string;
}

interface BlobFolder {
    name: string,
    files: BlobFolderFile[],
    children: BlobFolder[]
}

type CacheEntry = {
    name: string,
    url: string
};

interface Sponsor {
    id: string;
    name: string;
    image: string;
    url: string;
    class: string;
    hideAfter: string | null;
    createdAt: string;
    updatedAt: string;
}

interface User {
    id: string;
    username: string;
    email: string | null;
    role: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

declare module 'bluejay-rtttl-parse' {
    // biome-ignore lint/complexity/noStaticOnlyClass: <explanation>
    export default class Rtttl {
        static fromBluejayStartupMelody(startUpMelody: Uint8Array, name?: string): string;
        static toBluejayStartupMelody(rtttl: string, length?: number): {
            data: Uint8Array,
            errorCodes: number[]
        };
    }
};

declare module 'vue-matomo';
