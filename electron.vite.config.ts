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
        // ONE preload entry, deliberately. Two entries make rollup emit a
        // shared chunk that both bundles `require`, and a sandboxed preload's
        // `require` is a polyfill limited to electron/events/timers/url — which
        // left `window.lin` undefined in every window. The bundle exposes the
        // app bridge or the launcher's narrow one depending on the role flag
        // main passes; see docs/spec/action-registry.md.
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
