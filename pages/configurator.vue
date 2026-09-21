<template>
  <div>
    <div>
      <div v-if="!serialStore.hasSerial">
        <div class="text-3x text-red-500">
          WebSerial not supported! Please use other browser!
        </div>
      </div>
      <div v-else-if="escStore.count === 0">
        <div class="text-xl p-6 text-center text-orange-500">
          Please connect to a device and read settings.
        </div>
        <div class="flex justify-center">
          <UButton
            icon="i-heroicons-book-open"
            variant="ghost"
            size="xs"
            @click="guideOpen = true"
          >
            Settings cheat sheet
          </UButton>
        </div>
      </div>
      <div v-else-if="serialStore.isFourWay" class="pt-4 pb-12 h-full">
        <UTabs
          :items="tabs"
        >
          <template #tune>
            <div class="pt-4 flex flex-col gap-4">
              <div class="flex gap-4 w-full justify-center">
                <div v-for="(info, n) of escStore.escData" :key="n">
                  <EscView
                    :is-loading="info.isLoading"
                    :index="n"
                    :esc="info"
                    @change="onChange"
                    @toggle="onToggle"
                  />
                </div>
              </div>
              <div v-if="escStore.isLoading" class="flex justify-center items-center mt-20">
                <UIcon class="text-green-500 w-[80px] h-[80px]" name="i-svg-spinners-blocks-wave" dynamic />
              </div>
              <div v-else-if="escStore.selectedEscInfo.length > 0">
                <UCheckbox v-model="syncAllEscTunes" label="Sync all ESCs?" />
                <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div
                    v-for="n of escStore.selectedEscInfo.length"
                    :key="n"
                  >
                    <div>ESC {{ n }}</div>
                    <SchemaSettingsPanel
                      panel="tune"
                      :esc-info="escStore.selectedEscInfo"
                      :individual="n - 1"
                      :disabled="escStore.isBusy || (syncAllEscTunes && n > 1)"
                      @change="onTuneChange"
                    />
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template #settings>
            <div class="h-full pt-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 w-full justify-center">
                <div v-for="(info, n) of escStore.escData" :key="n">
                  <EscView
                    :is-loading="info.isLoading"
                    :index="n"
                    :esc="info"
                    @change="onChange"
                    @toggle="onToggle"
                  />
                </div>
              </div>
              <div v-if="escStore.isLoading" class="flex justify-center items-center mt-20">
                <UIcon class="text-green-500 w-[80px] h-[80px]" name="i-svg-spinners-blocks-wave" dynamic />
              </div>
              <div v-else-if="escStore.selectedEscInfo.length > 0" class="p-4 max-w-[1400px] m-auto">
                <div class="flex flex-col gap-4 justify-center">
                  <div class="flex justify-end">
                    <UButton
                      icon="i-heroicons-book-open"
                      variant="ghost"
                      size="xs"
                      @click="guideOpen = true"
                    >
                      Settings cheat sheet
                    </UButton>
                  </div>
                  <div v-for="cohort in cohorts" :key="cohort.key" class="space-y-4">
                    <div v-if="cohorts.length > 1" class="font-bold">
                      {{ cohort.label }}
                    </div>
                    <SchemaSettingsPanel panel="settings" :esc-info="cohort.escInfo" :disabled="escStore.isBusy" @change="onSettingsChange($event, cohort.escInfo)" />
                  </div>
                </div>
              </div>
            </div>
          </template>
        </UTabs>
      </div>
    </div>
    <USlideover v-model="guideOpen" :ui="{ width: 'w-screen max-w-4xl' }">
      <div class="p-4 overflow-y-auto h-full">
        <div class="flex justify-end mb-2">
          <UButton
            color="gray"
            variant="ghost"
            icon="i-heroicons-x-mark-20-solid"
            class="-my-1"
            @click="guideOpen = false"
          />
        </div>
        <SettingsGuide />
      </div>
    </USlideover>
  </div>
</template>
<script setup lang="ts">
import type { McuInfo } from 'am32-core/mcu';
import { escSchemaCohorts, schemaForEsc } from '~/utils/schema-settings';
import type { SettingChange } from '~/utils/schema-settings';

const serialStore = useSerialStore();
const escStore = useEscStore();
const syncAllEscTunes = ref(false);
const guideOpen = ref(false);
const cohorts = computed(() => escSchemaCohorts(escStore.selectedEscInfo));
const tabs = [
    { label: 'Base', slot: 'settings', icon: 'i-material-symbols-settings' },
    { label: 'Tune', slot: 'tune', icon: 'i-material-symbols-music-note' }
];

const onChange = (payload: SettingChange & { index: number }) => {
    const info = escStore.escData[payload.index]?.data;
    if (info) {
        onSettingsChange(payload, [info]);
    }
};
const onToggle = (index: number) => {
    const info = escStore.escData[index]?.data;
    if (info) {
        info.isSelected = !info.isSelected;
    }
};
const onSettingsChange = ({ field, value, individual }: SettingChange, targets = escStore.selectedEscInfo) => {
    const infos: McuInfo[] = individual === undefined ? targets : [targets[individual]];
    for (const info of infos) {
        if (info && schemaForEsc(info).aliases[field] && info.settings[field] !== undefined) {
            info.settings[field] = Array.isArray(value) ? [...value] : value;
            info.settingsDirty = true;
        }
    }
};
const onTuneChange = (change: SettingChange) => onSettingsChange({ ...change, individual: syncAllEscTunes.value ? undefined : change.individual });
</script>
