import { diffDays, plusDays } from './lib/date-utils.mjs'
import { loadRates, fillRates } from './lib/rate-loader.mjs'
import { formatCSV } from './lib/gpu-format.mjs'

const [SHADER_PREFIX, DEFAULT_SHADER, SHADER_SUFFIX] = await Promise.all([
  fetch('./scripts/lib/saron-prefix.wgsl').then(r => r.text()),
  fetch('./scripts/lib/saron-compound-rate.wgsl').then(r => r.text()),
  fetch('./scripts/lib/saron-suffix.wgsl').then(r => r.text()),
])

// ========== GPU Compute ==========

let gpuDevice = null

async function getDevice() {
  if (!gpuDevice) {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('WebGPU: no adapter found')
    gpuDevice = await adapter.requestDevice()
    if (!gpuDevice) throw new Error('WebGPU: could not get device')
    gpuDevice.lost.then(() => { gpuDevice = null })
  }
  return gpuDevice
}

async function runCompute(ratesData, weightsData, numDays, mode, totalOutputs, shaderSource) {
  const device = await getDevice()
  const fullShader = SHADER_PREFIX + shaderSource + SHADER_SUFFIX

  const module = device.createShaderModule({ code: fullShader })
  const compilationInfo = await module.getCompilationInfo()
  const errors = compilationInfo.messages.filter(m => m.type === 'error')
  if (errors.length > 0)
    throw new Error('Shader compilation errors:\n' + errors.map(e => e.message).join('\n'))

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })

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

// ========== Output Helpers ==========

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function makeFilename(startDate, endDate) {
  const now = new Date()
  const p = n => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}_${p(now.getMonth() + 1)}_${p(now.getDate())}-${p(now.getHours())}_${p(now.getMinutes())}`
  return `saron-compound-${startDate}_${endDate}_${ts}.csv`
}

// ========== State ==========

let loadedRateMap = null
let monacoEditor = null

// ========== UI Helpers ==========

const statusEl = document.getElementById('status')
const fileStatusEl = document.getElementById('fileStatus')
const calcBtn = document.getElementById('calcBtn')

function setStatus(msg, cls) {
  statusEl.textContent = msg
  statusEl.className = cls || ''
}

function updateCalcBtn() {
  calcBtn.disabled = !loadedRateMap
}

// ========== File Load ==========

document.getElementById('tsvFile').addEventListener('change', async e => {
  const file = e.target.files[0]
  if (!file) return
  try {
    const text = await file.text()
    const rates = loadRates(text)
    loadedRateMap = fillRates(rates)
    const keys = [...loadedRateMap.keys()]
    fileStatusEl.textContent = `${keys.length} daily rates loaded (${keys[0]} to ${keys[keys.length - 1]})`
    setStatus('Ready. Click Calculate to run.')
    updateCalcBtn()
  } catch (err) {
    loadedRateMap = null
    fileStatusEl.textContent = ''
    setStatus('File load error: ' + err.message, 'error')
    updateCalcBtn()
  }
})

// ========== All checkbox toggles allStartDates ==========

const allCheckbox = document.getElementById('all')
const allSDCheckbox = document.getElementById('allStartDates')
allCheckbox.addEventListener('change', () => {
  allSDCheckbox.disabled = !allCheckbox.checked
  if (!allCheckbox.checked) allSDCheckbox.checked = false
})

// ========== Calculate ==========

calcBtn.addEventListener('click', async () => {
  if (!loadedRateMap) return
  calcBtn.disabled = true
  setStatus('Preparing data...')

  try {
    const startDate = document.getElementById('startDate').value.trim()
    const userEndDate = document.getElementById('endDate').value.trim()
    const allFlag = allCheckbox.checked
    const allStartDatesFlag = allSDCheckbox.checked

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate))
      throw new Error('Invalid start date format')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(userEndDate))
      throw new Error('Invalid end date format')

    const rateMap = loadedRateMap
    const dates = [...rateMap.keys()]
    if (dates.length === 0) throw new Error('No rates found')
    if (startDate >= userEndDate)
      throw new Error(`Start date (${startDate}) must be before end date (${userEndDate})`)
    if (startDate < dates[0])
      throw new Error('Start date is before first rate date: ' + dates[0])
    if (plusDays(userEndDate, -10) > dates[dates.length - 1])
      throw new Error('End date is after last rate date: ' + dates[dates.length - 1])

    let d = startDate
    while (d < userEndDate) {
      if (!rateMap.has(d)) throw new Error('Missing rate for: ' + d)
      d = plusDays(d, 1)
    }

    const rateArray = [...rateMap.entries()].filter(
      ([date]) => date >= startDate && date <= userEndDate,
    )
    const endDate = plusDays(rateArray[rateArray.length - 1][0], 1)
    rateArray.push([endDate, { rate: '0.0', weight: 1 }])
    const numDays = diffDays(startDate, endDate)

    let mode, totalOutputs
    if (!allFlag) {
      mode = 0
      totalOutputs = 1
    } else if (!allStartDatesFlag) {
      mode = 1
      totalOutputs = numDays
    } else {
      mode = 2
      totalOutputs = (numDays * (numDays + 1)) / 2
    }

    setStatus(`Preparing ${totalOutputs.toLocaleString()} compound rates (${numDays} days, mode ${mode})...`)

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

    const shaderSource = monacoEditor ? monacoEditor.getValue() : DEFAULT_SHADER

    setStatus(`Computing ${totalOutputs.toLocaleString()} compound rates on GPU...`)
    const t0 = performance.now()
    const output = await runCompute(ratesData, weightsData, numDays, mode, totalOutputs, shaderSource)
    const tGpu = performance.now()

    setStatus('Formatting CSV...')
    const csv = formatCSV(output, rateArray, numDays, mode)
    const tFormat = performance.now()

    const filename = makeFilename(startDate, userEndDate)
    downloadFile(csv, filename)

    setStatus(
      `Done \u2014 ${totalOutputs.toLocaleString()} compound rates\n` +
      `GPU compute: ${(tGpu - t0).toFixed(0)} ms\n` +
      `CSV format:  ${(tFormat - tGpu).toFixed(0)} ms\n` +
      `Downloaded:  ${filename}\n\n` +
      `Precision: df64 (double-f32 emulation, ~48-bit mantissa) with f64 reconstruction.`,
      'success',
    )
  } catch (err) {
    setStatus('Error: ' + err.message, 'error')
    console.error(err)
  } finally {
    updateCalcBtn()
  }
})

// ========== Monaco Editor ==========

if (typeof require !== 'undefined' && require.config) {
  // Monaco loaded via CDN script tag
  initMonaco()
} else if (document.querySelector('script[data-monaco]')) {
  // Wait for Monaco loader script
  document.querySelector('script[data-monaco]').addEventListener('load', initMonaco)
}

function initMonaco() {
  require.config({
    paths: {
      vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.41.0/min/vs',
    },
  })
  require(['vs/editor/editor.main'], () => {
    monacoEditor = monaco.editor.create(document.querySelector('#editor'), {
      value: DEFAULT_SHADER,
      language: 'wgsl',
      theme: 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    })
  })
}
