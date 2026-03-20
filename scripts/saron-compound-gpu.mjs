#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { create as gpuCreate, globals as gpuGlobals } from 'webgpu'
import { diffDays, plusDays } from './lib/date-utils.mjs'
import { loadRates, fillRates } from './lib/rate-loader.mjs'
import { formatCSV } from './lib/gpu-format.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const wgsl = f => readFileSync(resolve(__dirname, 'lib', f), 'utf-8')
const SHADER_PREFIX = wgsl('saron-prefix.wgsl')
const DEFAULT_SHADER = wgsl('saron-compound-rate.wgsl')
const SHADER_SUFFIX = wgsl('saron-suffix.wgsl')

// --- WebGPU Compute ---

async function initGpu(shaderCode) {
	const { GPUBufferUsage, GPUMapMode } = gpuGlobals
	const gpuInstance = gpuCreate([])
	const adapter = await gpuInstance.requestAdapter()
	if (!adapter) throw new Error('WebGPU: no adapter found')
	const device = await adapter.requestDevice()
	if (!device) throw new Error('WebGPU: could not get device')

	const module = device.createShaderModule({ code: shaderCode })
	const compilationInfo = await module.getCompilationInfo()
	const errors = compilationInfo.messages.filter(m => m.type === 'error')
	if (errors.length > 0)
		throw new Error('Shader compilation errors:\n' + errors.map(e => e.message).join('\n'))

	const pipeline = device.createComputePipeline({
		layout: 'auto',
		compute: { module, entryPoint: 'main' },
	})

	return { device, pipeline, GPUBufferUsage, GPUMapMode }
}

async function dispatch(device, pipeline, GPUBufferUsage, GPUMapMode, ratesData, weightsData, numDays, mode, totalOutputs) {
	const ratesBuffer = device.createBuffer({
		size: ratesData.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	})
	device.queue.writeBuffer(ratesBuffer, 0, ratesData)

	const weightsBuffer = device.createBuffer({
		size: weightsData.byteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
	})
	device.queue.writeBuffer(weightsBuffer, 0, weightsData)

	const outputBuffer = device.createBuffer({
		size: totalOutputs * 8,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
	})

	const paramsData = new Uint32Array([numDays, mode, totalOutputs, 0])
	const paramsBuffer = device.createBuffer({
		size: paramsData.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	})
	device.queue.writeBuffer(paramsBuffer, 0, paramsData)

	const readBuffer = device.createBuffer({
		size: totalOutputs * 8,
		usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
	})

	const bindGroup = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: ratesBuffer } },
			{ binding: 1, resource: { buffer: weightsBuffer } },
			{ binding: 2, resource: { buffer: outputBuffer } },
			{ binding: 3, resource: { buffer: paramsBuffer } },
		],
	})

	const encoder = device.createCommandEncoder()
	const pass = encoder.beginComputePass()
	pass.setPipeline(pipeline)
	pass.setBindGroup(0, bindGroup)
	pass.dispatchWorkgroups(Math.ceil(totalOutputs / 256))
	pass.end()
	encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, totalOutputs * 8)
	device.queue.submit([encoder.finish()])

	await readBuffer.mapAsync(GPUMapMode.READ)
	const result = new Float32Array(readBuffer.getMappedRange().slice(0))
	readBuffer.unmap()

	ratesBuffer.destroy()
	weightsBuffer.destroy()
	outputBuffer.destroy()
	paramsBuffer.destroy()
	readBuffer.destroy()

	return result
}

// --- CLI ---

function usage() {
	console.error('Usage: saron-compound-gpu.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates] [shaderPath]')
	console.error('')
	console.error('  tsvPath        Path to TSV file with date/rate columns')
	console.error('  startDate      Start date (YYYY-MM-DD)')
	console.error('  endDate        End date (YYYY-MM-DD)')
	console.error('  all            true/false (default: false)')
	console.error('  allStartDates  true/false (default: false)')
	console.error('  shaderPath     Path to custom WGSL shader file (replaces default compoundRate)')
	process.exit(1)
}

const args = process.argv.slice(2)
if (args.length < 3) usage()

const tsvPath = args[0]
const startDate = args[1]
let endDate = args[2]
const all = args[3] === 'true'
const allStartDates = args[4] === 'true'

const customRate = args[5] ? readFileSync(args[5], 'utf-8') : null
const shaderCode = SHADER_PREFIX + (customRate || DEFAULT_SHADER) + SHADER_SUFFIX

const data = readFileSync(tsvPath, 'utf-8')
const rates = loadRates(data)
const rateMap = fillRates(rates)

// Validate
const dates = [...rateMap.keys()]
if (dates.length === 0) throw new Error('No rates found')
if (startDate >= endDate)
	throw new Error(`StartDate (${startDate}) must be before endDate (${endDate})`)
if (startDate < dates[0])
	throw new Error('StartDate is before first rate date: ' + dates[0])
if (plusDays(endDate, -10) > dates[dates.length - 1])
	throw new Error('EndDate is after last rate date: ' + dates[dates.length - 1])

let d = startDate
while (d < endDate) {
	if (!rateMap.has(d)) throw new Error('Missing rate for: ' + d)
	d = plusDays(d, 1)
}

// Build rateArray
const rateArray = [...rateMap.entries()].filter(
	([date]) => date >= startDate && date <= endDate
)
endDate = plusDays(rateArray[rateArray.length - 1][0], 1)
rateArray.push([endDate, { rate: '0.0', weight: 1 }])
const numDays = diffDays(startDate, endDate)

// Mode
let mode, totalOutputs
if (!all) {
	mode = 0
	totalOutputs = 1
} else if (!allStartDates) {
	mode = 1
	totalOutputs = numDays
} else {
	mode = 2
	totalOutputs = numDays * (numDays + 1) / 2
}

// Build typed arrays — rates as df64 (hi, lo) pairs
const ratesData = new Float32Array(numDays * 2)
const weightsData = new Uint32Array(numDays)
const f32Tmp = new Float32Array(1)
for (let i = 0; i < numDays; i++) {
	const val = parseFloat(rateArray[i][1].rate)
	f32Tmp[0] = val
	const hi = f32Tmp[0]
	f32Tmp[0] = val - hi
	const lo = f32Tmp[0]
	ratesData[2 * i] = hi
	ratesData[2 * i + 1] = lo
	weightsData[i] = rateArray[i][1].weight
}

// Run GPU compute (separate init from calculation timing)
const { device, pipeline, GPUBufferUsage, GPUMapMode } = await initGpu(shaderCode)
const t0 = performance.now()
const output = await dispatch(device, pipeline, GPUBufferUsage, GPUMapMode, ratesData, weightsData, numDays, mode, totalOutputs)
const elapsed = performance.now() - t0
process.stderr.write(`${elapsed.toFixed(1)} ms\n`)
device.destroy()

process.stdout.write(formatCSV(output, rateArray, numDays, mode))
