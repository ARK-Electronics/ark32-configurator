<template>
  <div>
    <NuxtPwaManifest />
    <div class="min-h-screen bg-gray-950 text-white">
      <NuxtLayout class="h-full">
        <NuxtPage />
      </NuxtLayout>
      <UNotifications />
    </div>
  </div>
</template>
<script setup>
const { $pwa } = useNuxtApp();

const toast = useToast();

onMounted(() => {
    if ($pwa?.offlineReady) {
        toast.add({
            icon: 'i-material-symbols-install-desktop',
            color: 'green',
            title: 'Installation',
            description: 'App successfully installed. Offline work available.'
        });
    }

    if ($pwa?.needRefresh) {
        toast.add({
            icon: 'i-material-symbols-cloud-sync',
            color: 'green',
            title: 'Update',
            description: 'Update available, please reload.',
            timeout: 3,
            callback: () => {
                window.location.reload();
            }
        });
    }
});

const serialStore = useSerialStore();
const { log, logError } = useLogStore();

// Nothing to initialise any more: the protocol stack is created per connection by
// `useEscSession`, which owns one `Am32Session` and the transport under it. The
// two singletons that used to be primed here were the app's second protocol
// implementation, deleted in block 5 of issue #3.
if (import.meta.client && typeof navigator !== 'undefined' && 'serial' in navigator) {
    serialStore.hasSerial = true;

    log('initializing...');
} else if (import.meta.client) {
    serialStore.hasSerial = false;
    logError('WebSerial not supported, use Chrome/Edge for ESC configuration.');
}
</script>
