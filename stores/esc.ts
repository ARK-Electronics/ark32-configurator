import type { EscData } from 'am32-core/mcu';

export const useEscStore = defineStore('esc', () => {
    /**
     * Channels the FC said it will address, from the `MSP_SET_PASSTHROUGH` reply.
     * Mirrored from `Am32Session.escCount`.
     */
    const expectedCount = ref(0);

    const escData = ref<EscData[]>([]);

    /**
     * Channels that came back healthy.
     *
     * Derived rather than counted: block 5 had it incremented in one place and
     * assigned in another, which is the shape a stale count comes from.
     */
    const count = computed(() => escData.value.filter(e => !e.isError && e.data).length);

    const selectedEscInfo = computed(() => escData.value.filter(e => !e.isError && e.data?.isSelected).map(e => e.data) ?? []);
    const firstValidEscData = computed(() => escData.value?.find(d => !d.isError && d.data));

    const isSaving = ref(false);
    const isLoading = ref(false);

    // There was also a store-level `settingsDirty` flag here. It was written in
    // two places and read in none -- the live one is per ESC, on `McuInfo`. Gone
    // with the rest of audit item I.

    /**
     * The channel a long per-ESC operation is running on, or -1.
     *
     * Load-bearing for the UI: it drives `:prevent-close` on the flash modal, so
     * anything that leaves it set after an operation ends wedges that dialog open.
     * Written by the session's `progress` events and cleared in
     * `useEscSession.flashTargets`'s `finally` (audit item **G**).
     */
    const activeTarget = ref(-1);
    const totalBytes = ref(0);
    const bytesWritten = ref(0);
    /** The current phase's label, mirrored from the session's `progress` events. */
    const step = ref('');

    const $reset = () => {
        expectedCount.value = 0;
        escData.value = [];

        activeTarget.value = -1;
        totalBytes.value = 0;
        bytesWritten.value = 0;
        step.value = '';
    };

    return { isSaving, isLoading, count, expectedCount, escData, selectedEscInfo, firstValidEscData, activeTarget, totalBytes, bytesWritten, step, $reset };
});

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useEscStore, import.meta.hot));
}
