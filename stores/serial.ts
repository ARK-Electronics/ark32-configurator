import { defineStore, acceptHMRUpdate } from 'pinia';
import type { FcInfo } from 'am32-core/session';

export const NO_DEVICE = { id: '-1', label: 'Select device' } as const;

const sharesUsbId = (usbIds: string[], usb: string): boolean =>
    usbIds.filter(other => other === usb).length > 1;

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

    /**
     * One id per `SerialPort` object rather than per VID:PID. An ArduPilot
     * board's two USB CDC ports share a VID:PID, and keying on it connected to
     * whichever port the browser listed first, not the one the user picked.
     * Chrome returns the same object for a port from every `getPorts()`.
     */
    const portIds = new WeakMap<SerialPort, string>();
    let lastPortId = 0;
    const portId = (port: SerialPort): string => {
        let id = portIds.get(port);
        if (!id) {
            lastPortId += 1;
            id = `port-${lastPortId}`;
            portIds.set(port, id);
        }
        return id;
    };
    const usbId = (port: SerialPort): string => {
        const info = port.getInfo();
        return `0x${padStr(info.usbVendorId?.toString(16) ?? '', 4, '0')}:0x${padStr(info.usbProductId?.toString(16) ?? '', 4, '0')}`;
    };

    const pairedDevicesOptions = computed(() => {
        const usbIds = pairedDevices.value.map(usbId);
        return pairedDevices.value.map((port, index) => {
            const usb = usbIds[index] as string;
            // Web Serial does not expose the USB interface, so ports that share
            // a VID:PID can only be numbered.
            const nth = usbIds.slice(0, index + 1).filter(other => other === usb).length;
            return { id: portId(port), label: sharesUsbId(usbIds, usb) ? `${usb} (${nth})` : usb, usb };
        });
    });
    const selectedDevice = ref<{ id: string, label: string, usb?: string }>({ ...NO_DEVICE });

    // No port handle here. The transport owns the reader, the writer and the port
    // for the lifetime of a connection, and `selectedDevice` is what the UI needs
    // to know. A stored `port` would be another write-only field of exactly the
    // kind audit item I is about.

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

        // An unplugged or rebooted board comes back as new port objects. Follow
        // it only when the choice is unambiguous.
        if (selectedDevice.value.id !== NO_DEVICE.id && !selectedPort()) {
            const [only, ...others] = pairedDevicesOptions.value.filter(o => o.usb === selectedDevice.value.usb);
            selectedDevice.value = only && others.length === 0 ? only : { ...NO_DEVICE };
        }
    }

    /** Select the last port listed, unless another port shares its VID:PID. */
    function selectDefaultDevice () {
        const options = pairedDevicesOptions.value;
        const last = options[options.length - 1];
        if (last && !sharesUsbId(options.map(o => o.usb), last.usb)) {
            selectedDevice.value = last;
        }
    }

    function selectPort (port: SerialPort) {
        const option = pairedDevicesOptions.value.find(o => o.id === portIds.get(port));
        if (option) {
            selectedDevice.value = option;
        }
    }

    /** The port behind the selected entry, or null once the browser stops listing it. */
    function selectedPort (): SerialPort | null {
        return pairedDevices.value.find(port => portIds.get(port) === selectedDevice.value.id) ?? null;
    }

    function $reset () {
        hasConnection.value = false;
        isFourWay.value = false;
        fc.value = null;
    }

    return { fc, motorCount, isFourWay, hasConnection, hasSerial, addSerialDevices, selectDefaultDevice, selectPort, selectedPort, pairedDevices, pairedDevicesOptions, selectedDevice, $reset };
});

export type SerialStore = ReturnType<typeof useSerialStore>

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useSerialStore, import.meta.hot));
}
