// recto-layout.mjs — where things live in a Recto checkout, and how to serve it.
//
// Recto exists in two layouts, and the tools here work with either:
//   static   the client-side site: web/plugins/ocr_tool/{engine,glyphs,cache}/,
//            served by `node tools/serve.mjs <port>`; its build stamps every
//            script with a content hash, so no cache-buster is rewritten here
//   django   the original app: ocr_tool/static/ocr_tool/{engine,glyphs}/ and
//            ocr_tool/cache/, served by `manage.py runserver`; engine
//            cache-busters live in ocr_tool/tool.py
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function rectoLayout(recto) {
  if (existsSync(join(recto, 'web', 'plugins', 'ocr_tool', 'plugin.json')) && existsSync(join(recto, 'tools', 'serve.mjs'))) {
    const plugin = join(recto, 'web', 'plugins', 'ocr_tool');
    return {
      kind: 'static', plugin,
      engineDir: join(plugin, 'engine'), glyphDir: join(plugin, 'glyphs'), cacheDir: join(plugin, 'cache'),
      toolPy: null,
      server: port => ({ command: process.execPath, args: [join('tools', 'serve.mjs'), String(port)] }),
    };
  }
  if (existsSync(join(recto, 'manage.py')) && existsSync(join(recto, 'ocr_tool', 'tool.py'))) {
    const plugin = join(recto, 'ocr_tool');
    return {
      kind: 'django', plugin,
      engineDir: join(plugin, 'static', 'ocr_tool', 'engine'), glyphDir: join(plugin, 'static', 'ocr_tool', 'glyphs'),
      cacheDir: join(plugin, 'cache'),
      toolPy: join(plugin, 'tool.py'),
      server: port => ({ command: process.platform === 'win32' ? 'python' : 'python3',
                         args: ['manage.py', 'runserver', `127.0.0.1:${port}`, '--noreload'] }),
    };
  }
  return null;
}

// In the page, "a document is open" reads state.pageImages.length on the Django
// app and state.numPages on the static site (pages come from Doc on demand).
