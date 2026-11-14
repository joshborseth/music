/*
 * Builds the visuals lab: one self-contained HTML page that runs the TV's
 * own shaders (apps/tv/src/visuals/shaders) in the browser with WebGL 2, so
 * scenes can be seen and tuned without a TV.
 *
 *   bun apps/tv/visuals-lab/build.ts   → dist/index.html  live, with controls
 *                                        dist/sheet.html  every scene, still, side by side
 *                                        dist/sheet-<moment>.html  one moment of the song
 *                                        dist/bench.html  times each scene
 *                                        dist/moments.html  changes of scene, builds, glitch
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const here = import.meta.dir
const shaderDir = join(here, '../src/visuals/shaders')

const shaders: Record<string, string> = {}
for (const name of await readdir(shaderDir)) {
  shaders[name] = await Bun.file(join(shaderDir, name)).text()
}

const bundle = await Bun.build({
  entrypoints: [join(here, 'lab.ts')],
  target: 'browser',
  minify: false,
})
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}
const [output] = bundle.outputs
if (output === undefined) throw new Error('no bundle output')
const script = await output.text()

const page = (mode: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visuals lab</title>
<style>
  :root { color-scheme: dark; --bg: #08070d; --fg: #ece9f5; --muted: #8c88a0; --line: #2a2738; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 system-ui, sans-serif; }
  #stage { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  #stage canvas { width: 100%; height: 100%; display: block; }
  #hud { position: absolute; left: 12px; top: 10px; font: 12px ui-monospace, monospace; color: #fff; text-shadow: 0 1px 2px #000; white-space: pre; pointer-events: none; }
  #controls { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 12px; border-bottom: 1px solid var(--line); }
  #controls button { background: #1b1926; color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  #controls button[aria-pressed="true"] { background: #ece9f5; color: #08070d; }
  #controls label { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  #sheet { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; padding: 10px; }
  #sheet figure { margin: 0; }
  #sheet canvas { width: 100%; display: block; border-radius: 6px; }
  #sheet figcaption { color: var(--muted); padding: 4px 2px; }
</style>
</head>
<body>
<script>const SHADERS = ${JSON.stringify(shaders)}; const MODE = '${mode}';</script>
<script>${script}</script>
</body>
</html>
`

await Bun.write(join(here, 'dist/index.html'), page('live'))
await Bun.write(join(here, 'dist/sheet.html'), page('sheet'))
await Bun.write(join(here, 'dist/bench.html'), page('bench'))
// A real song, played through the TV's own listener: see `song` in lab.ts.
await Bun.write(join(here, 'dist/song.html'), page('song'))
// The moments: each change of scene, a build into its drop, the glitch,
// and what a change costs (moments.ts).
await Bun.write(join(here, 'dist/moments.html'), page('moments'))
// One moment of the made-up song each, quicker to render.
for (const moment of ['verse', 'build', 'drop']) {
  await Bun.write(
    join(here, `dist/sheet-${moment}.html`),
    page(`sheet:${moment}`),
  )
}
console.log(`Wrote ${join(here, 'dist')}`)
