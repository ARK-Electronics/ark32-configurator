<template>
  <div class="min-w-[350px]">
    <div class="p-4 grid grid-cols-1 gap-2">
      <div class="flex flex-column gap-2">
        <USelectMenu v-model="serialStore.selectedDevice" class="flex-grow" :disabled="serialStore.hasConnection" :options="serialStore.pairedDevicesOptions" placeholder="Select device" />
        <USelectMenu
          v-model="baudrate"
          class="flex-grow"
          :disabled="serialStore.selectedDevice.id === '-1' || serialStore.hasConnection"
          :options="baudrateOptions"
        />
      </div>
      <div class="flex justify-between gap-2">
        <UButton size="2xs" @click="requestSerialDevices">
          Port select
        </UButton>
        <UButton v-if="!serialStore.hasConnection" :disabled="serialStore.selectedDevice.id === '-1' || escStore.isBusy" :loading="escStore.isBusy" size="2xs" @click="connectToDevice">
          Connect
        </UButton>
        <UButton v-else size="2xs" color="red" @click="disconnectFromDevice">
          Disconnect
        </UButton>
      </div>
      <div class="flex gap-4 pt-2">
        <div class="flex gap-2 items-center">
          <UIcon name="i-fluent-serial-port-16-filled" dynamic :class="[serialStore.hasConnection ? 'text-green-500' : 'text-red-500']" />
        </div>
        <div v-if="serialStore.hasConnection && escChipCount > 0" class="w-full flex justify-between gap-4">
          <div class="flex gap-2">
            <UChip
              v-for="n of escChipCount"
              :key="n"
              :text="n"
              size="2xl"
              color="blue"
            >
              <UIcon
                name="i-heroicons-cpu-chip-16-solid"
                class="text-xs"
                :class="{
                  'text-green-500': !escStore.escData[n - 1]?.isLoading && !escStore.escData[n - 1]?.isError,
                  'text-orange-500': escStore.escData[n - 1]?.isLoading,
                  'text-red-500': escStore.escData[n - 1]?.isError,
                  'text-white': !escStore.escData[n - 1]
                }"
              />
            </UChip>
          </div>
          <div class="flex gap-2">
            <UButton icon="i-material-symbols-find-in-page-outline" size="2xs" :loading="escStore.isLoading" :disabled="escStore.isBusy" @click="connectToEsc">
              Read
            </UButton>
            <UButton
              icon="i-material-symbols-save"
              color="blue"
              size="2xs"
              :disabled="!isAnySettingsDirty || escStore.isSaving || escStore.isBusy"
              :loading="escStore.isSaving"
              @click="writeConfig"
            >
              Save
            </UButton>
          </div>
        </div>
      </div>
      <div v-if="serialStore.hasConnection && escStore.count > 0" class="flex gap-4 w-full">
        <div class="w-full flex flex-col space-y-2">
          <UButton label="Flash firmware" size="2xs" icon="i-material-symbols-full-stacked-bar-chart" color="teal" @click="flashModalOpen = true" />
          <UButton
            label="Send default config"
            size="2xs"
            icon="i-material-symbols-sim-card-outline"
            color="green"
            @click="applyDefaultConfigModalOpen = true"
          />
        </div>
        <div class="min-w-[112px]">
          <UButton
            label="Save config"
            size="xs"
            icon="i-material-symbols-sim-card-download-outline"
            color="red"
            variant="link"
            @click="saveConfigModalOpen = true"
          />
          <UButton
            label="Apply config"
            size="xs"
            icon="i-material-symbols-upload-file-outline"
            color="violet"
            variant="link"
            @click="applyConfigModalOpen = true"
          />
        </div>
      </div>
      <UModal v-model="flashModalOpen" :prevent-close="escStore.activeTarget > -1">
        <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
          <template #header>
            <div class="flex items-center justify-between">
              <div class="flex items-center justify-center gap-2 text-xl">
                <UIcon name="i-material-symbols-full-stacked-bar-chart" class="h-8 w-8" />
                <div class="text-2xl">
                  Flash Firmware
                </div>
              </div>
            </div>
          </template>

          <div v-if="true" class="flex flex-col gap-4">
            <UCheckbox
              v-model="ignoreMcuLayout"
              :disabled="isFlashingActive"
              :ui="{
                label: 'text-sm font-medium text-red-700 dark:text-red-500',
              }"
              label="Ignore current mcu layout"
              color="red"
            />
            <UAlert
              v-if="ignoreMcuLayout"
              icon="i-heroicons-exclamation-triangle"
              title="Alert!"
              variant="subtle"
              color="red"
              description="If you flash a wrong mcu type, you will brick the mcu, recovering from this will take some effort!"
            />
            <UCheckbox
              v-model="includePrerelease"
              :disabled="isFlashingActive"
              :ui="{
                label: 'text-sm font-medium text-orange-700 dark:text-orange-500',
              }"
              label="Include prerelease versions"
              color="orange"
            />
            <UAlert
              v-if="includePrerelease"
              icon="i-heroicons-exclamation-triangle"
              title="Be aware!"
              variant="subtle"
              color="orange"
              description="Prerelease or release candidate versions might have bugs, if you encounter issues, please join our discord and report them!"
            />
            <UTabs
              v-model="currentTab"
              :items="flashTabs"
            >
              <template #release>
                <div class="flex flex-col gap-4">
                  <USelectMenu
                    v-model="selectedRelease"
                    searchable
                    searchable-placeholder="Search a release..."
                    :disabled="isFlashingActive"
                    :options="releasesOptions"
                    :loading="status === 'pending'"
                  />
                  <USelectMenu
                    v-model="selectedAsset"
                    searchable
                    searchable-placeholder="Search a hex file..."
                    :options="assets"
                    :disabled="assets?.length === 0 || !ignoreMcuLayout || isFlashingActive"
                    :loading="status === 'pending'"
                  />
                </div>
              </template>
              <template #local>
                <div class="flex flex-col gap-4">
                  <UInput
                    type="file"
                    size="sm"
                    icon="i-heroicons-folder"
                    accept=".hex"
                    :disabled="isFlashingActive"
                    @change="selectFile($event)"
                  />
                  <div v-if="isFlashingActive" class="text-green-500 text-center">
                    Flashing local '{{ fileInput?.name ?? 'UNKNOWN' }}'
                  </div>
                </div>
              </template>
            </UTabs>
          </div>
          <div v-else class="text-green-500 text-center">
            Flashing local '{{ fileInput ?? 'UNKNOWN' }}'
          </div>
          <div v-if="serialStore.isFourWay" class="pt-4">
            <div class="text-center mb-2">
              Select ESC(s) to flash:
            </div>
            <div class="w-full text-center flex justify-center gap-2">
              <div
                v-for="n of escStore.selectedEscInfo.length"
                :key="n"
                class="transition-all w-8 h-8 rounded-full text-center border border-gray-500 bg-gray-800 p-1 cursor-pointer"
                :class="{
                  'ring-2 ring-green-500 bg-green-300/30': savingOrApplyingSelectedEscs.includes(n)
                }"
                @click="toggleSavingOrApplyingSelectedEsc(n);"
              >
                {{ n }}
              </div>
            </div>
          </div>
          <template #footer>
            <div class="flex flex-col items-end gap-4">
              <div v-if="escStore.activeTarget === -1" class="flex gap-4">
                <UButton
                  label="Start flash"
                  :loading="downloading"
                  :disabled="
                    escStore.isBusy || downloading ||
                      (savingOrApplyingSelectedEscs.length === 0) ||
                      (currentTab === 0 && (!selectedAsset || selectedAsset === 'NOT FOUND')) ||
                      (currentTab > 0 && !fileInput)
                  "
                  @click="startModalFlash"
                />
              </div>
              <div v-if="downloading" class="text-green-500">
                {{ escStore.step }}
              </div>
              <div v-if="escStore.activeTarget > -1" class="w-full">
                Flashing ESC #{{ (escStore.activeTarget + 1) }}
                <UProgress
                  :value="progressIsIntermediate ? undefined : (escStore.bytesWritten / escStore.totalBytes) * 100"
                  :indicator="!progressIsIntermediate"
                  animation="carousel"
                />
                <div class="flex justify-center pt-2 text-green-500">
                  <div>{{ escStore.step }}</div>
                </div>
              </div>
            </div>
          </template>
        </UCard>
      </UModal>
      <UModal v-model="applyDefaultConfigModalOpen">
        <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
          <template #header>
            <div class="flex items-center justify-between">
              <div class="flex items-center justify-center gap-2 text-xl">
                <UIcon name="i-material-symbols-sim-card-outline" class="h-8 w-8" />
                <div class="text-2xl">
                  Apply default config
                </div>
              </div>
            </div>
          </template>
          <div>
            <div class="flex flex-col gap-2">
              <div class="text-center">
                Select ESC(s) to apply:
              </div>
              <div class="w-full text-center flex justify-center gap-2">
                <div
                  v-for="n of escStore.selectedEscInfo.length"
                  :key="n"
                  class="transition-all w-8 h-8 rounded-full text-center border border-gray-500 bg-gray-800 p-1 cursor-pointer"
                  :class="{
                    'ring-2 ring-green-500 bg-green-300/30': savingOrApplyingSelectedEscs.includes(n)
                  }"
                  @click="toggleSavingOrApplyingSelectedEsc(n);"
                >
                  {{ n }}
                </div>
              </div>
            </div>
          </div>
          <template #footer>
            <div class="text-right">
              <UButton color="green" label="Apply" :disabled="savingOrApplyingSelectedEscs.length === 0 || escStore.isBusy" @click="applyDefaultConfig" />
            </div>
          </template>
        </UCard>
      </UModal>
      <UModal v-model="saveConfigModalOpen">
        <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
          <template #header>
            <div class="flex items-center justify-between">
              <div class="flex items-center justify-center gap-2 text-xl">
                <UIcon name="i-material-symbols-sim-card-download-outline" class="h-8 w-8" />
                <div class="text-2xl">
                  Save current ESC config
                </div>
              </div>
            </div>
          </template>
          <div>
            <div class="flex flex-col gap-2">
              <div class="text-center">
                Select ESC(s) to save:
              </div>
              <div class="w-full text-center flex justify-center gap-2">
                <div
                  v-for="n of escStore.selectedEscInfo.length"
                  :key="n"
                  class="transition-all w-8 h-8 rounded-full text-center border border-gray-500 bg-gray-800 p-1 cursor-pointer"
                  :class="{
                    'ring-2 ring-green-500 bg-green-300/30': savingOrApplyingSelectedEscs.includes(n)
                  }"
                  @click="toggleSavingOrApplyingSelectedEsc(n);"
                >
                  {{ n }}
                </div>
              </div>
            </div>
          </div>
          <template #footer>
            <div class="text-right">
              <UButton label="Download" :disabled="savingOrApplyingSelectedEscs.length === 0" @click="downloadEscConfig" />
            </div>
          </template>
        </UCard>
      </UModal>
      <UModal v-model="applyConfigModalOpen">
        <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
          <template #header>
            <div class="flex items-center justify-between">
              <div class="flex items-center justify-center gap-2 text-xl">
                <UIcon name="i-material-symbols-sim-card-download-outline" class="h-8 w-8" />
                <div class="text-2xl">
                  Apply ESC config
                </div>
              </div>
            </div>
          </template>
          <div>
            <div class="flex flex-col gap-2">
              <UInput ref="applyConfigFile" type="file" color="primary" variant="outline" placeholder=".bin" />
              <div class="text-center">
                Select ESC(s) to apply:
              </div>
              <div class="w-full text-center flex justify-center gap-2">
                <div
                  v-for="n of escStore.selectedEscInfo.length"
                  :key="n"
                  class="transition-all w-8 h-8 rounded-full text-center border border-gray-500 bg-gray-800 p-1 cursor-pointer"
                  :class="{
                    'ring-2 ring-green-500 bg-green-300/30': savingOrApplyingSelectedEscs.includes(n)
                  }"
                  @click="toggleSavingOrApplyingSelectedEsc(n);"
                >
                  {{ n }}
                </div>
              </div>
            </div>
          </div>
          <template #footer>
            <div class="text-right">
              <UButton label="Apply" :disabled="savingOrApplyingSelectedEscs.length === 0 || escStore.isBusy || applyConfigFile?.input.files.length === 0" @click="applyConfig" />
            </div>
          </template>
        </UCard>
      </UModal>
    </div>
  </div>
</template>

<script setup lang="ts">
import db from '~/src/db';

/**
 * UI and store mirroring only.
 *
 * Everything this component used to do on the wire -- MSP framing, the 4-way
 * retry loop, the 4.5 s ArduPilot wait, the enumerate loop, the flash page walk --
 * now lives in `Am32Session` and is reached through `useEscSession`. That is
 * block 5 of issue #3: the app becomes a thin client so the `ark32` CLI can drive
 * the same code. If you find yourself needing a protocol constant or a
 * millisecond number in this file, it belongs in `packages/am32-core`.
 */
const toast = useToast();
const serialStore = useSerialStore();
const escStore = useEscStore();
const { logError } = useLogStore();
const escSession = useEscSession();

const usbFCVendorIds = [0x0483, 0x2E3C, 0x2E8A, 0x1209, 0x26AC, 0x27AC, 0x2DAE, 0x3162, 0x35A7];
const flashModalOpen = ref(false);
const applyDefaultConfigModalOpen = ref(false);
const saveConfigModalOpen = ref(false);
const applyConfigModalOpen = ref(false);
const fileInput = ref<File | null>(null);
const currentTab = ref(0);
const applyConfigFile = ref();

const selectedRelease = ref('');
const selectedAsset = ref('');
const ignoreMcuLayout = ref(false);
const includePrerelease = ref(false);
const savingOrApplyingSelectedEscs = ref<number[]>([]);
const isFlashingActive = computed(() => escStore.activeTarget > -1);
/**
 * True while a release hex is being fetched.
 *
 * The old code faked this by setting `escStore.activeTarget = 0` before the fetch,
 * which locked the modal shut -- and left it locked for good if the download
 * failed. A download is cancellable; what it must not allow is a second Start
 * flash click, which is what this disables.
 */
const downloading = ref(false);

const progressIsIntermediate = computed(() => !['Writing', 'Verifying'].includes(escStore.step));

/**
 * How many ESC chips to show.
 *
 * `motorCount` is `MSP_MOTOR_CONFIG` byte 6; `expectedCount` is the
 * `MSP_SET_PASSTHROUGH` reply, i.e. how many channels the FC will actually let us
 * address. They are different numbers and on Betaflight they can disagree, so the
 * row is sized by whichever is largest rather than by the one that happens to be
 * populated.
 */
const escChipCount = computed(() => Math.max(
    serialStore.motorCount,
    escStore.expectedCount,
    escStore.escData.length
));

const { data, status } = useAsyncData('get-releases', () => useFetch(`/api/files?filter=releases${includePrerelease.value ? '&prereleases' : ''}`), {
    watch: [includePrerelease]
});

const releases = computed(() => {
    const tmp = data.value?.data as unknown as { data: BlobFolder[] };
    return tmp?.data ?? [];
});

const assets = computed(() => (releases.value?.[0]?.children.find(c => c.name === selectedRelease.value)?.files.map(f => f.name)));

const releasesOptions = computed(() => {
    return (releases.value?.[0]?.children.map(c => c.name) ?? []).sort((a, b) => b.localeCompare(a));
});

const flashTabs = computed(() => [
    { label: 'Release', disabled: isFlashingActive.value, slot: 'release' },
    { label: 'Local', disabled: isFlashingActive.value, slot: 'local' }
]);

watch(releasesOptions, (d) => {
    if (!selectedRelease.value && d?.length > 0) {
        setTimeout(() => {
            selectedRelease.value = d[0];
        }, 200);
    }
});

watch(includePrerelease, (b, a) => {
    if (b !== a) {
        selectedAsset.value = '';
        selectedRelease.value = '';
    }
});

const toggleSavingOrApplyingSelectedEsc = (n: number) => {
    if (savingOrApplyingSelectedEscs.value.includes(n)) {
        savingOrApplyingSelectedEscs.value = [
            ...savingOrApplyingSelectedEscs.value.filter(num => num !== n)
        ];
    } else {
        savingOrApplyingSelectedEscs.value.push(n);
    }
};

watchEffect(() => {
    if (assets.value && escStore.escData.length > 0) {
        const tag = selectedRelease.value;
        const cleanTag = tag.substring(1).replace(/-rc[1-9]*[0-9]*/gi, '');
        const currentAsset = assets.value?.find(a => a === `AM32_${escStore.firstValidEscData?.data.meta.am32.fileName ?? 'ERROR'}_${cleanTag}.hex`);
        selectedAsset.value = currentAsset ?? 'NOT FOUND';
    }
});

const isAnySettingsDirty = computed(() => escStore.escData.some(e => e.data?.settingsDirty));

const baudrateOptions = ref([
    '1000000',
    '500000',
    '256000',
    '115200',
    '57600',
    '38400',
    '19200',
    '14400',
    '9600'
]);

const baudrate = ref('115200');

const requestSerialDevices = async () => {
    await navigator.serial.requestPort({
        filters: usbFCVendorIds.map(id => ({ usbVendorId: id }))
    });
    await fetchPairedDevices();
};

const fetchPairedDevices = async () => {
    const pairedDevices: SerialPort[] = await navigator.serial.getPorts();
    serialStore.addSerialDevices(pairedDevices);

    if (pairedDevices.length > 0) {
        if (serialStore.selectedDevice.id === '-1') {
            serialStore.selectLastDevice();
        }
    } else {
        // The browser has forgotten the port. Tear the session down rather than
        // just clearing the flags, or the transport keeps its reader.
        if (serialStore.hasConnection) {
            await escSession.disconnect();
        }
        serialStore.selectedDevice = {
            id: '-1',
            label: 'Select device'
        };
    }
};

fetchPairedDevices();

useIntervalFn(() => {
    fetchPairedDevices();
}, 500);

const findSelectedPort = async (): Promise<SerialPort | null> => {
    const [vendorId, productId] = serialStore.selectedDevice.id.split(':');
    const ports = await navigator.serial.getPorts();
    return ports.find(p => p.getInfo().usbVendorId === +vendorId && p.getInfo().usbProductId === +productId) ?? null;
};

const connectToDevice = async () => {
    const router = useRouter();
    if (!router.currentRoute.value.fullPath.startsWith('/configurator')) {
        router.push({
            path: '/configurator'
        });
    }

    const port = await findSelectedPort();
    if (!port) {
        logError('Serial port not found');
        return;
    }

    // One call: the session opens the port, probes MSP immediately and only sits
    // out ArduPilot's MAVLink idle window if it has to. The unconditional 4.5 s
    // wait every connect used to pay was audit item H.
    await escSession.connect(port, +baudrate.value);
};

const disconnectFromDevice = async () => {
    await escSession.disconnect();
};

/**
 * Read every ESC, then apply the two recovery policies the app has always had.
 *
 * Both used to sit below an enumerate loop that dereferenced `.data` on channels
 * that had failed, so one dead ESC threw a `TypeError` out of this handler and
 * neither policy ran at all (audit item **B**). They now only ever look at
 * channels that came back.
 */
const connectToEsc = async () => {
    const results = await escSession.readAll();
    if (results.length === 0) {
        return;
    }

    const healthy = escStore.escData.filter(e => !e.isError && e.data);

    // A fresh or half-flashed ESC: an EEPROM page that is all 0xFF or all zero.
    const isBlank = (buffer: Uint8Array) =>
        buffer.length === 0 ||
        buffer.every(b => b === 0xFF) ||
        buffer.reduce((acc, cur) => acc + cur, 0) === 0;

    if (healthy.some(e => isBlank(e.data.settingsBuffer))) {
        toast.add({
            title: 'Error',
            color: 'red',
            description: 'Found empty settings, flashing default settings now!'
        });

        savingOrApplyingSelectedEscs.value = escStore.escData
            .map((e, i) => (!e.isError && e.data ? i + 1 : 0))
            .filter(n => n > 0);

        await applyDefaultConfig();
        return;
    }

    // AM32 2.19 shipped with a TIMING_ADVANCE that means something different from
    // what it meant before, so a value carried over from an older EEPROM is wrong.
    const needsTimingFix = healthy.some((e) => {
        const version = `${e.data.settings.MAIN_REVISION}.${e.data.settings.SUB_REVISION}`;
        return version.endsWith('2.19') && (e.data.settings.TIMING_ADVANCE as number) < 10;
    });

    if (needsTimingFix) {
        for (const esc of healthy) {
            esc.data.settings.TIMING_ADVANCE = 16;
            esc.data.settingsDirty = true;
        }
        if (await escSession.saveDirtySettings()) {
            toast.add({
                title: 'Info',
                color: 'blue',
                description: 'Eeprom upgraded. Adjusted settings, saved and applied!'
            });
        }
    }
};

const writeConfig = async () => {
    await escSession.saveDirtySettings();
};

const selectFile = (event: Event | FileList) => {
    if (event instanceof Event && event.target instanceof HTMLInputElement && event.target.files?.[0]) {
        fileInput.value = event.target.files[0];
    } else if (event instanceof FileList) {
        fileInput.value = event[0];
    }
};

const startModalFlash = async () => {
    if (currentTab.value === 0) {
        const url = releases.value?.[0]?.children.find(c => c.name === selectedRelease.value)?.files.find(f => f.name === selectedAsset.value)?.url;
        if (!url) {
            return;
        }

        downloading.value = true;
        escStore.step = 'Downloading firmware';
        try {
            const cached = await db.downloads.where('url').equals(url).first();
            if (cached) {
                downloading.value = false;
                await startFlash(cached.text);
                return;
            }

            const text = await (await fetch(url)).text();
            await db.downloads.add({ url, text });
            await startFlash(text);
        } catch (error: any) {
            // A download that fails must not leave the modal locked, which is the
            // same defect as audit item G one step earlier in the path.
            toast.add({
                title: 'Download failed',
                color: 'red',
                description: error.message
            });
        } finally {
            downloading.value = false;
            if (escStore.activeTarget === -1) {
                escStore.step = '';
            }
        }
    } else if (currentTab.value === 1 && fileInput.value) {
        await startFlash(await fileInput.value.text());
    }
};

/**
 * Flash the selected ESCs.
 *
 * The MCU-layout check that used to live here is inside `session.flash()` now,
 * where it compares the hex against the *target* channel's own firmware name
 * rather than against ESC #1's. `ignoreMcuLayout` is the caller's opt-out.
 *
 * A failure surfaces as a toast and releases the modal instead of wedging it open
 * -- audit item **G**. The release happens in `useEscSession.flashTargets`'s
 * `finally`, so it cannot be forgotten by a call site.
 */
const startFlash = async (hexString: string) => {
    const targets = savingOrApplyingSelectedEscs.value.map(n => n - 1);
    const flashed = await escSession.flashTargets(hexString, targets, {
        allowMcuMismatch: ignoreMcuLayout.value
    });

    if (!flashed) {
        return;
    }

    flashModalOpen.value = false;
    toast.add({
        title: 'Success',
        color: 'green',
        description: `Flashed ${targets.length} ESC(s)`
    });

    // The session already re-read each ESC it flashed; this re-runs the fresh-EEPROM
    // and 2.19 recovery policies over the whole board, which is what the old flash
    // path did by calling straight back into the read handler.
    await connectToEsc();
};

/**
 * The catalog's per-board default settings image, or null if it is out of reach.
 *
 * Two hops because the endpoint hands back a presigned URL rather than bytes. Both
 * hops are status-checked: with no MinIO configured the route answers 503, and the
 * old code fed that error body to `fetch()` as a URL, which threw out of the click
 * handler. A null here is not a failure -- the session falls back to AM32's own
 * built-in defaults.
 */
const fetchDefaultSettingsImage = async (
    fileName: string | null,
    version: number
): Promise<Uint8Array | null> => {
    try {
        const url = await fetch(`/api/eeprom/${fileName}?version=${version}`).then((res) => {
            if (res.status === 200) {
                return res.text();
            }
            return fetch(`/api/eeprom/DEFAULT?version=${version}`)
                .then(fallback => (fallback.status === 200 ? fallback.text() : null));
        });
        if (!url) {
            return null;
        }
        const bytes = await fetch(url).then(res => res.arrayBuffer());
        return new Uint8Array(bytes);
    } catch {
        return null;
    }
};

/**
 * Reset the selected ESCs to defaults.
 *
 * The decoding, the melody and the "which fields does a reset write" question all
 * live in `session.applyDefaults` now. That last one was a real bug here: the app
 * staged *every* field it decoded from the default file, so a reset also wrote the
 * boot byte, the layout revision and the firmware version -- and a layout revision
 * of 3 on an older ESC makes its firmware skip its own migration.
 */
const applyDefaultConfig = async () => {
    const first = escStore.firstValidEscData?.data;
    if (!first) {
        return;
    }

    let eepromVersion = first.settings.LAYOUT_REVISION as number;
    if (eepromVersion > 3) {
        eepromVersion = 2;
    }

    const image = await fetchDefaultSettingsImage(first.meta.am32.fileName, eepromVersion);
    if (!image) {
        // Visible rather than silent: these are AM32's defaults, not necessarily
        // this board's, and a user whose catalog is misconfigured should know.
        toast.add({
            title: 'Using built-in defaults',
            color: 'orange',
            description: 'The firmware catalog did not have a default for this board.'
        });
    }

    if (!await escSession.applyDefaults(savingOrApplyingSelectedEscs.value, image ?? undefined)) {
        return;
    }

    applyDefaultConfigModalOpen.value = false;
};

const downloadEscConfig = () => {
    for (const n of savingOrApplyingSelectedEscs.value) {
        const buffer = escStore.escData[n - 1]?.data?.settingsBuffer;
        if (!buffer) {
            continue;
        }
        const blob = new Blob([buffer.buffer as ArrayBuffer], {
            type: 'application/octet-stream'
        });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `esc${n}_config.bin`;
        link.click();
        URL.revokeObjectURL(link.href);
    }
};

const applyConfig = async () => {
    const files: FileList | undefined = applyConfigFile.value?.input?.files;
    if (!files || files.length !== 1) {
        return;
    }

    const buffer = new Uint8Array(await files[0].arrayBuffer());
    const settings = escSession.decodeSettingsFile(
        buffer,
        escStore.firstValidEscData?.data.settings.LAYOUT_REVISION as number
    );

    await escSession.applySettings(settings, savingOrApplyingSelectedEscs.value);

    applyConfigFile.value.input.value = '';
    applyConfigModalOpen.value = false;
};
</script>
