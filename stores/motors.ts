import { defineStore, acceptHMRUpdate } from 'pinia';
import type { MotorTestStatus } from 'am32-core/session';

const OFF: MotorTestStatus = { phase: 'off', unlocked: false, responding: true, throttle: [] };

/** The session's motor test, mirrored from its `motors` events by `useEscSession`. */
export const useMotorStore = defineStore('motors', () => {
    const status = ref<MotorTestStatus>({ ...OFF });
    const active = computed(() => status.value.phase !== 'off');

    const $reset = () => {
        status.value = { ...OFF };
    };

    return { status, active, $reset };
});

if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(useMotorStore, import.meta.hot));
}
