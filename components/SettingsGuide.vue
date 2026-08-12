<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-2">
      <h1 class="text-2xl font-bold">
        EEPROM settings cheat sheet
      </h1>
      <p class="text-sm text-gray-300">
        Each row is one EEPROM setting, in layout order. Units are what this configurator shows, not the raw byte. <span class="text-gray-400">ARK default</span> is the ARK 4IN1 factory image.
      </p>
    </div>
    <UInput
      v-model="query"
      icon="i-heroicons-magnifying-glass"
      placeholder="Filter settings…"
      size="sm"
    />
    <div class="border border-gray-700 rounded overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-gray-400">
          <tr class="border-b border-gray-800">
            <th class="px-3 py-2 font-medium whitespace-nowrap">
              Setting
            </th>
            <th class="px-3 py-2 font-medium whitespace-nowrap">
              Range
            </th>
            <th class="px-3 py-2 font-medium whitespace-nowrap">
              ARK default
            </th>
            <th class="px-3 py-2 font-medium">
              What it does
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry of visibleEntries"
            :key="entry.field"
            class="border-b border-gray-800 last:border-0 align-top"
          >
            <td class="px-3 py-2 whitespace-nowrap">
              <div>{{ entry.name }}</div>
              <div class="text-xs text-gray-500 font-mono">
                {{ entry.field }}
              </div>
            </td>
            <td class="px-3 py-2 text-gray-300 whitespace-nowrap">
              {{ entry.range }}
            </td>
            <td class="px-3 py-2 text-gray-300 whitespace-nowrap">
              {{ entry.arkDefault }}
            </td>
            <td class="px-3 py-2 text-gray-200">
              {{ entry.help }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p
      v-if="visibleEntries.length === 0"
      class="text-sm text-gray-400 text-center py-8"
    >
      No settings match “{{ query }}”.
    </p>
  </div>
</template>
<script setup lang="ts">
import { SETTING_GUIDE } from 'am32-core/eeprom/guide';

const query = ref('');

const visibleEntries = computed(() => {
    const needle = query.value.trim().toLowerCase();
    if (!needle) {
        return SETTING_GUIDE;
    }
    return SETTING_GUIDE.filter(entry => [
        entry.name,
        entry.field,
        entry.range,
        entry.arkDefault,
        entry.help
    ].some(part => part.toLowerCase().includes(needle)));
});
</script>
