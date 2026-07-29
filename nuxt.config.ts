import { fileURLToPath } from 'node:url';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    // The protocol core is consumed straight from TypeScript source rather than
    // a build artifact, so there is no build step to forget and no stale dist to
    // debug. `transpile` is what makes Vite compile it instead of treating a
    // workspace symlink as a prebuilt dependency.
    alias: {
        'am32-core': fileURLToPath(new URL('./packages/am32-core/src', import.meta.url))
    },

    build: {
        transpile: ['am32-core']
    },

    devtools: {
        enabled: true,

        timeline: {
            enabled: true
        }
    },

    typescript: {
        shim: false,
        typeCheck: true
    },

    nitro: {
        storage: {
            uploads: {
                driver: 'fs',
                base: './public/uploads'
            }
        }
    },

    ssr: false,

    // Fail if the requested port is taken (avoids silent move to 3001 and a
    // confused ./run.sh health check).
    vite: {
        server: {
            strictPort: true
        }
    },

    runtimeConfig: {
        redis: { // Default values
            host: process.env.REDIS_HOST,
            port: 6379
            /* other redis connector options */
        },
        mariadb: {
            host: process.env.MYSQL_HOST || 'mariadb',
            port: parseInt(process.env.MYSQL_PORT || '3306'),
            user: process.env.MYSQL_USER || 'am32',
            password: process.env.MYSQL_PASSWORD || 'am32password',
            database: process.env.MYSQL_DATABASE || 'am32'
        }
    },

    modules: [
        '@vite-pwa/nuxt',
        'nuxt-svgo',
        'dayjs-nuxt',
        '@nuxt/ui',
        '@pinia/nuxt',
        '@vueuse/nuxt',
        ['@nuxtjs/google-fonts', {
            families: {
                Roboto: true,
                'Nunito Sans': true
            }
        }],
        '@nuxt/content',
        '@nuxt/image'
    ],

    pinia: {
        storesDirs: ['./stores/**']
    },

    colorMode: {
        preference: 'dark'
    },

    svgo: {
        autoImportPath: false,
        explicitImportsOnly: true
    },

    pwa: {
        registerType: 'autoUpdate',
        manifest: {
            id: '/',
            name: 'AM32 configurator',
            short_name: 'AM32CONF',
            theme_color: '#000000',
            description: 'Configurator for the ESC firmware AM32',
            icons: [
                {
                    src: 'assets/images/am32-logo.png',
                    sizes: '848x848',
                    type: 'image/png'
                },
                {
                    src: 'assets/images/192x192.png',
                    sizes: '192x192',
                    type: 'image/png'
                },
                {
                    src: 'assets/images/144x144.png',
                    sizes: '144x144',
                    type: 'image/png',
                    purpose: 'any'
                },
                {
                    src: 'assets/images/96x96.png',
                    sizes: '96x96',
                    type: 'image/png',
                    purpose: 'any'
                }
            ],
            screenshots: [
                {
                    src: 'assets/images/screenshot1.png',
                    sizes: '1742x918',
                    type: 'image/png',
                    form_factor: 'wide',
                    label: '4in1 ESC'
                },
                {
                    src: 'assets/images/screenshot1.png',
                    sizes: '1742x918',
                    type: 'image/png',
                    form_factor: 'narrow',
                    label: '4in1 ESC'
                }
            ]
        },
        // workbox: {
        //    globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        //    navigateFallback: '/'
        // },
        client: {
            installPrompt: true,
            // you don't need to include this: only for testing purposes
            // if enabling periodic sync for update use 1 hour or so (periodicSyncForUpdates: 3600)
            periodicSyncForUpdates: 3600
        },
        devOptions: {
            enabled: true,
            suppressWarnings: true,
            navigateFallbackAllowlist: [/^\/$/],
            type: 'module'
        }
    },

    compatibilityDate: '2024-09-16'
});
