import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';

/** json-bigint require()'s bignumber.js; Vite can wrap it so .isBigNumber is missing. */
function fixJsonBigintBigNumber() {
  return {
    name: 'fix-json-bigint-bignumber',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('/json-bigint/')) return null;
      if (!code.includes("require('bignumber.js')")) return null;

      return {
        code: code.replace(
          /var BigNumber = require\(['"]bignumber\.js['"]\);/,
          `var BigNumber = require('bignumber.js');
if (BigNumber && BigNumber.default) BigNumber = BigNumber.default;
if (BigNumber && BigNumber.BigNumber) BigNumber = BigNumber.BigNumber;`
        ),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [
    fixJsonBigintBigNumber(),
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
    alias: {
      // Prefer CJS BigNumber (has .isBigNumber) over ESM namespace export
      'bignumber.js': resolve(__dirname, 'node_modules/bignumber.js/bignumber.js'),
      // Extern-WASM ORT build without forcing a global 'import' condition
      'onnxruntime-web': resolve(
        __dirname,
        'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'
      ),
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
      transformMixedEsModules: true,
      requireReturnsDefault: 'auto',
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
