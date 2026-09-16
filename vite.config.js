import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
          dest: 'ort',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
          dest: 'ort',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
          dest: 'ort',
        },
        {
          src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
          dest: 'ort',
        },
      ],
    }),
  ],
  resolve: {
    // Load the non-bundled ORT build; WASM is served from /ort/
    conditions: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
    // Force CJS BigNumber so Appwrite's json-bigint gets .isBigNumber
    alias: {
      'bignumber.js': resolve(__dirname, 'node_modules/bignumber.js/bignumber.js'),
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        map: resolve(__dirname, 'map.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
    include: ['appwrite', 'json-bigint', 'bignumber.js'],
  },
});
