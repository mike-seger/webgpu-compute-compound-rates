import { diffDays, plusDays } from './lib/date-utils.mjs'
import { loadRates, fillRates } from './lib/rate-loader.mjs'
import { formatCSV } from './lib/gpu-format.mjs'
import { cpuCompoundCSV } from './lib/cpu-compound.mjs'

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
const diffViewEl = document.getElementById('diffView')

let lastGpuCsv = ''
let lastCpuCsv = ''
let lastFilename = ''

function setStatus(msg, cls, html) {
  if (html) statusEl.innerHTML = msg; else statusEl.textContent = msg
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
    fileStatusEl.textContent = `${keys.length} rates (${keys[0]} to ${keys[keys.length - 1]})`
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

    setStatus(`Computing ${totalOutputs.toLocaleString()} compound rates...`)

    const t0Gpu = performance.now()
    const output = await runCompute(ratesData, weightsData, numDays, mode, totalOutputs, shaderSource)
    const t1Gpu = performance.now()
    const gpuCsv = formatCSV(output, rateArray, numDays, mode)
    const t2Gpu = performance.now()

    const t0Cpu = performance.now()
    const cpuCsv = cpuCompoundCSV(rateArray, numDays, mode)
    const t1Cpu = performance.now()

    const filename = makeFilename(startDate, userEndDate)
    lastGpuCsv = gpuCsv
    lastCpuCsv = cpuCsv
    lastFilename = filename

    populateDiff(gpuCsv, cpuCsv)
    switchTab('diff')

    const gpuMs = (t1Gpu - t0Gpu).toFixed(0)
    const gpuFmtMs = (t2Gpu - t1Gpu).toFixed(0)
    const cpuMs = (t1Cpu - t0Cpu).toFixed(0)
    const speedup = ((t1Cpu - t0Cpu) / (t1Gpu - t0Gpu)).toFixed(1)
    const rows = totalOutputs.toLocaleString()
    const diffCount = diffLines.filter(d => !d.isHeader && d.differs).length

    setStatus(
      `<span class="stat-left">${rows} compound rates \u00b7 ${diffCount} differing line${diffCount !== 1 ? 's' : ''}\nGPU speedup: ${speedup}x</span>` +
      `<span class="stat-right">           Compute    Format\nGPU  ${gpuMs.padStart(8)} ms ${gpuFmtMs.padStart(8)} ms\nCPU  ${cpuMs.padStart(8)} ms</span>`,
      'success',
      true,
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
  initMonaco()
} else {
  const el = document.querySelector('script[data-monaco]')
  if (el) el.addEventListener('load', initMonaco)
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

// ========== Tabs ==========

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name))
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === name))
  if (name === 'editor' && monacoEditor) monacoEditor.layout()
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchTab(t.dataset.tab))
)

// ========== Diff Helpers ==========

let diffLines = []

function populateDiff(gpuCsv, cpuCsv) {
  const gpuRows = gpuCsv.split('\n')
  const cpuRows = cpuCsv.split('\n')
  const maxLen = Math.max(gpuRows.length, cpuRows.length)
  diffLines = []
  for (let i = 0; i < maxLen; i++) {
    const g = gpuRows[i] ?? ''
    const c = cpuRows[i] ?? ''
    diffLines.push({ lineNum: i, gpu: g, cpu: c, differs: g !== c, isHeader: i === 0 })
  }
  renderDiff()
}

function renderDiff() {
  const hideCommon = document.getElementById('hideCommon').checked
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const visible = diffLines.filter(d => d.isHeader || !hideCommon || d.differs)

  let numsHtml = ''
  let gpuHtml = ''
  let cpuHtml = ''

  for (const d of visible) {
    const num = d.isHeader ? '&nbsp;' : d.lineNum
    let cls = 'diff-line'
    if (!d.isHeader) {
      if (d.gpu === '' && d.cpu !== '') cls += ' added'
      else if (d.gpu !== '' && d.cpu === '') cls += ' removed'
      else if (d.differs) cls += ' changed'
    }
    numsHtml += `<div class="diff-line diff-num">${num}</div>`
    gpuHtml += `<div class="${cls}">${esc(d.gpu)}</div>`
    cpuHtml += `<div class="${cls}">${esc(d.cpu)}</div>`
  }

  diffViewEl.innerHTML =
    `<div class="diff-nums-col">${numsHtml}</div>` +
    `<div class="diff-col">${gpuHtml}</div>` +
    `<div class="diff-col">${cpuHtml}</div>`
}

document.getElementById('hideCommon').addEventListener('change', renderDiff)

// ========== Diff Actions ==========

document.getElementById('gpuDownloadBtn').addEventListener('click', () => {
  if (lastGpuCsv) downloadFile(lastGpuCsv, lastFilename)
})

document.getElementById('gpuCopyBtn').addEventListener('click', () => {
  if (lastGpuCsv) navigator.clipboard.writeText(lastGpuCsv)
})

document.getElementById('cpuDownloadBtn').addEventListener('click', () => {
  if (lastCpuCsv) downloadFile(lastCpuCsv, lastFilename.replace('saron-compound-', 'saron-compound-cpu-'))
})

document.getElementById('cpuCopyBtn').addEventListener('click', () => {
  if (lastCpuCsv) navigator.clipboard.writeText(lastCpuCsv)
})
