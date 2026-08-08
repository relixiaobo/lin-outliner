import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
      'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1'),
    },
    build: {
      rollupOptions: {
        input: 'src/main/main.ts',
        external: ['electron'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        // Two preload bundles. `index` is the app bridge (main window, Settings,
        // provider config). `launcher` is the locked-down launcher's ENTIRE
        // bridge and deliberately omits the generic `lin:invoke` surface, so a
        // compromised launcher renderer cannot acquire it by reloading — see
        // docs/spec/action-registry.md.
        input: {
          index: 'src/preload/index.ts',
          launcher: 'src/preload/launcher.ts',
        },
        external: ['electron'],
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: '.',
    plugins: [react()],
    clearScreen: false,
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    build: {
      rollupOptions: {
        // Two renderer entries: the main app and the dedicated, lightweight
        // launcher. The launcher entry must not pull in the editor bundle.
        input: {
          index: 'index.html',
          launcher: 'launcher.html',
        },
      },
    },
    server: {
      port: 5173,
    },
  },
});
