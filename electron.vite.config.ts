import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
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
    build: {
      rollupOptions: {
        input: 'index.html',
      },
    },
    server: {
      port: 5173,
    },
  },
});
