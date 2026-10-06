<template>
  <div class="p-4 pb-16 max-w-3xl m-auto flex flex-col gap-6">
    <div>
      <div class="text-2xl font-bold">
        Motor test
      </div>
      <div class="text-sm text-gray-400">
        Spins the motors through the flight controller. ESC N is flight controller motor output N.
      </div>
    </div>

    <div v-if="!serialStore.hasSerial" class="text-red-500">
      Web Serial is not supported in this browser.
    </div>
    <div v-else-if="!serialStore.hasConnection" class="text-xl p-6 text-center text-orange-500">
      Connect to the flight controller to test motors.
    </div>
    <template v-else>
      <UAlert
        v-if="startError"
        icon="i-heroicons-exclamation-triangle"
        color="red"
        variant="subtle"
        title="Motor test unavailable"
        :description="startError"
        :actions="[{ label: 'Try again', color: 'red', variant: 'solid', click: start }]"
      />
      <UAlert
        v-else-if="status.phase === 'off'"
        icon="i-heroicons-information-circle"
        color="primary"
        variant="subtle"
        title="The motor test is off"
        :actions="[{ label: 'Start motor test', color: 'primary', variant: 'solid', click: start }]"
      />
      <UAlert
        v-else-if="status.phase === 'starting'"
        icon="i-svg-spinners-ring-resize"
        color="primary"
        variant="subtle"
        title="Waiting for the ESCs to boot and arm"
      />
      <UAlert
        v-else-if="status.phase === 'reversing'"
        icon="i-svg-spinners-ring-resize"
        color="primary"
        variant="subtle"
        :title="`Reversing ESC ${(status.target ?? 0) + 1}`"
        description="Writing its direction over passthrough, then waiting for the ESCs to boot and arm."
      />
      <UAlert
        v-if="status.error"
        icon="i-heroicons-exclamation-triangle"
        color="orange"
        variant="subtle"
        title="Motors stopped"
        :description="status.error"
      />

      <UButton
        block
        size="xl"
        color="red"
        icon="i-heroicons-stop-circle"
        :disabled="status.phase === 'off'"
        @click="stop"
      >
        Stop all motors (Esc)
      </UButton>

      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-[6rem_1fr_3.5rem_10rem] items-center gap-4 border-b border-gray-700 pb-4">
          <div class="font-bold">
            All ESCs
          </div>
          <URange
            :model-value="master"
            :min="0"
            :max="100"
            :step="1"
            :disabled="locked"
            @update:model-value="setAll"
          />
          <div class="text-right tabular-nums">
            {{ master }}%
          </div>
          <div />
        </div>
        <div
          v-for="(throttle, i) of status.throttle"
          :key="i"
          class="grid grid-cols-[6rem_1fr_3.5rem_10rem] items-center gap-4"
        >
          <div>ESC {{ i + 1 }}</div>
          <URange
            :model-value="percent(throttle)"
            :min="0"
            :max="100"
            :step="1"
            :disabled="locked"
            @update:model-value="(value: number) => escSession.setMotorThrottle(i, fromPercent(value))"
          />
          <div class="text-right tabular-nums">
            {{ percent(throttle) }}%
          </div>
          <UButton
            size="xs"
            variant="outline"
            icon="i-heroicons-arrow-path"
            :disabled="status.phase !== 'ready' || escStore.isBusy"
            :loading="status.phase === 'reversing' && status.target === i"
            @click="escSession.reverseMotorDirection(i)"
          >
            Reverse direction
          </UButton>
        </div>
      </div>

      <div class="border-t border-gray-700 pt-6 flex items-center gap-4">
        <UToggle
          color="red"
          :model-value="status.unlocked"
          :disabled="status.phase !== 'ready' || !status.responding || escStore.isBusy"
          @update:model-value="onToggle"
        />
        <div class="font-bold">
          Props removed, I understand the motors will spin
        </div>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { MOTOR_THROTTLE_MAX } from 'am32-core/session';

const serialStore = useSerialStore();
const escStore = useEscStore();
const motorStore = useMotorStore();
const escSession = useEscSession();

const status = computed(() => motorStore.status);
const locked = computed(() => !status.value.unlocked || status.value.phase !== 'ready');
const master = ref(0);
const startError = ref<string | null>(null);
/** Start once per connection on its own; after that only from a button. */
const autoStarted = ref(false);

const percent = (throttle: number) => Math.round(throttle * 100 / MOTOR_THROTTLE_MAX);
const fromPercent = (value: number) => value * MOTOR_THROTTLE_MAX / 100;

const start = async () => {
    startError.value = await escSession.startMotorTest();
};

const stop = () => escSession.stopMotors();

const setAll = (value: number) => {
    if (escSession.setAllMotorThrottle(fromPercent(value))) {
        master.value = value;
    }
};

const onToggle = (on: boolean) => {
    if (on) {
        escSession.unlockMotors();
    } else {
        stop();
    }
};

watch(() => status.value.unlocked, (unlocked) => {
    if (!unlocked) {
        master.value = 0;
    }
});

// Wait out the connect itself: it holds the session, so starting inside it is refused as busy.
watch(
    () => serialStore.hasConnection && serialStore.fc !== null && !escStore.isBusy,
    (connected) => {
        if (connected && !autoStarted.value && !motorStore.active) {
            autoStarted.value = true;
            start();
        }
        if (!serialStore.hasConnection) {
            autoStarted.value = false;
            startError.value = null;
        }
    },
    { immediate: true }
);

useEventListener(document, 'visibilitychange', () => {
    if (document.hidden) {
        stop();
    }
});
useEventListener(window, 'pagehide', stop);
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
        stop();
    }
});

onBeforeRouteLeave(async () => {
    await escSession.endMotorTest();
});
onBeforeUnmount(() => {
    escSession.endMotorTest();
});
</script>
