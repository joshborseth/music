import * as ort from 'onnxruntime-node'

import { INPUT_SIDE, toDepthMap, toInputTensor } from './process.ts'

/*
 * Works out one cover's depth, in a process of its own: the server starts
 * it under `nice`, so the model's few hundred megabytes and second of CPU
 * never touch the server's own process or its event loop, and are all given
 * back the moment it ends.
 *
 *   bun runner.ts <model.onnx>  < RGB bytes, INPUT_SIDE² × 3
 *                               > depth bytes, DEPTH_SIDE²
 *
 * ONNX Runtime's CPU build ships inside `onnxruntime-node`, so it needs no
 * install script (Bun blocks that one, which only fetches CUDA libraries).
 */

const [modelPath] = process.argv.slice(2)
if (modelPath === undefined) {
  console.error('Usage: bun runner.ts <model.onnx>')
  process.exit(2)
}

const rgb = new Uint8Array(await Bun.stdin.arrayBuffer())
const input = toInputTensor(rgb)

const session = await ort.InferenceSession.create(modelPath, {
  // Two threads: about a second for a cover, and room left for everything
  // else on the box. Without the memory arena the process peaks lower.
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  enableCpuMemArena: false,
  graphOptimizationLevel: 'all',
})
const [inputName] = session.inputNames
const [outputName] = session.outputNames
if (inputName === undefined || outputName === undefined) {
  console.error('The model has no input or output')
  process.exit(1)
}
const outputs = await session.run({
  [inputName]: new ort.Tensor('float32', input, [1, 3, INPUT_SIDE, INPUT_SIDE]),
})
const output = outputs[outputName]
if (output === undefined || !(output.data instanceof Float32Array)) {
  console.error('The model answered no depth')
  process.exit(1)
}
const side = output.dims.at(-1) ?? 0
const depth = toDepthMap(output.data, side)
await Bun.write(Bun.stdout, depth)
await session.release()
