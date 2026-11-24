import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wsPort = Number(process.env.IC_WS_PORT ?? 9451);

function bundleStamp(): string {
  const files = ['src/index.ts', 'src/agent.ts', 'src/transport.ts', 'src/mixer.ts', 'src/audio-clock.ts'];
  const hash = createHash('sha1');
  for (const file of files) {
    const full = resolve(here, file);
    if (existsSync(full)) hash.update(readFileSync(full));
  }
  hash.update(String(Date.now()));
  return hash.digest('hex').slice(0, 10);
}

/**
 * Guest 运行时打包：单文件 IIFE，无外部依赖，产出 dist/guest.bundle.js。
 * Bridge 直接把这个文件的内容丢进 Runtime.evaluate，完成热注入。
 */
export default defineConfig({
  build: {
    lib: {
      entry: resolve(here, 'src/index.ts'),
      name: 'IncrediboxAgent',
      formats: ['iife'],
      fileName: () => 'guest.bundle.js',
    },
    outDir: resolve(here, '../../dist'),
    emptyOutDir: false,
    target: 'chrome110',
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  define: {
    __BUNDLE_HASH__: JSON.stringify(bundleStamp()),
    __AGENT_VERSION__: JSON.stringify(`1.0.${Date.now().toString(36).slice(-4)}`),
    __WS_PORT__: JSON.stringify(wsPort),
  },
});
