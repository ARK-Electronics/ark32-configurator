import { defineStore, acceptHMRUpdate } from 'pinia';
import type { FcInfo } from 'am32-core/session';

/**
 * Everything the UI needs to know about the serial link, and nothing more.
 *
 * Block 5 emptied this out. It used to hold a record of stream handles -- a
 * reader, a writer and two protocol-class instances -- plus an action that
 * grabbed a second reader behind the transport's back: all of it audit item
 * **I**, all of it unused since block 2 moved stream ownership into `am32-web`'s
 * transport. The MSP facts the FC reported went the same way, replaced by
 * `FcInfo` from the session, which carries the variant, the API version, the
 * motor count, the battery and the quirks and is produced by the same code the
 * CLI runs. `scripts/assert-deleted.sh` names the removed symbols; this file
 * deliberately does not, because that gate greps these directories for them.
 *
 * `hasConnection` and `isFourWay` are **mirrors of the session's state**, written
 * only by `useEscSession`'s event handler. Nothing else may set them: they used
 * to be poked by hand at each call site, which is how `isFourWay` came to be set
 * true before `MSP_SET_PASSTHROUGH` was known to have succeeded.
 */
export const useSerialStore = defineStore('serial', () => {
    const hasConnection = ref(false);
    const hasSerial = ref(true);
    const isFourWay = ref(false);
    const pairedDevices = ref<SerialPort[]>([]);
    const pairedDevicesOptions = computed(() => pairedDevices.value.map(d =>
        ({ id: `${d.getInfo().usbVendorId}:${d.getInfo().usbProductId}`, label: `0x${padStr(d.getInfo().usbVendorId?.toString(16) ?? '', 4, '0')}:0x${padStr(d.getInfo().usbProductId?.toString(16) ?? '', 4, '0')}` }))
    );
    const selectedDevice = ref<{ id: string, label: string }>({
        id: '-1',
        label: 'Select device'
    });

    /**
     * The port the user picked, kept only so the UI can tell whether one is
     * chosen. The reader and the writer belong to the transport for the lifetime
     * of the connection.
     */
    const port = ref<SerialPort | null>(null);

    /** What `connect()` found. Null until then. */
    const fc = ref<FcInfo | null>(null);

    /**
     * `MSP_MOTOR_CONFIG` byte 6, the authoritative motor count on both firmwares.
     *
     * Not the same number as the session's ESC count, which comes from the
     * `MSP_SET_PASSTHROUGH` reply and is how many channels the FC will let us
     * address. On Betaflight the two can differ.
     */
    const motorCount = computed(() => fc.value?.motorCount ?? 0);

    function addSerialDevices (devices: SerialPort[]) {
        pairedDevices.value = [
            ...devices
        ];
    }

    function selectLastDevice () {
        selectedDevice.value = pairedDevicesOptions.value[pairedDevicesOptions.value.length - 1];
    }

    function $reset () {
        hasConnection.value = false;
        isFourWay.value = false;
        port.value = null;
        fc.value = null;
    }

    return { fc, motorCount, isFourWay, hasConnection, hasSerial, addSerialDevices, selectLastDevice, pairedDevices, pairedDevicesOptions, selectedDevice, port, $reset };
});

export type SerialStore = ReturnType<typeof useSerialStore>

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useSerialStore, import.meta.hot));
}
