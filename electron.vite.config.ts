import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: 'src/main/main.ts',
        external: ['electron', 'ws', 'bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
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
