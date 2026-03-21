import { diffDays, plusDays } from './lib/date-utils.mjs'
import { loadRates, fillRates } from './lib/rate-loader.mjs'
import { formatCSV } from './lib/gpu-format.mjs'
import { cpuCompoundCSV } from './lib/f64/f64-compound.mjs'
import { rationalCompoundCSV } from './lib/rational/rational-compound.mjs'
import { bigDecimalCompoundCSV } from './lib/bigdecimal/bigdecimal-compound.mjs'

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
let lastBdCsv = ''
let lastRationalCsv = ''
let lastFilename = ''

function setStatus(msg, cls, html) {
  if (html) statusEl.innerHTML = msg; else statusEl.textContent = msg
  statusEl.className = cls || ''
}

function updateCalcBtn() {
  calcBtn.disabled = !loadedRateMap
}

// ========== File Load ==========

function applyRates(text) {
  const rates = loadRates(text)
  loadedRateMap = fillRates(rates)
  const keys = [...loadedRateMap.keys()]
  fileStatusEl.textContent = `${rates.length} rates (${keys[0]} to ${keys[keys.length - 1]})`
  setStatus('Ready. Click Calculate to run.')
  updateCalcBtn()
}

document.getElementById('tsvFile').addEventListener('change', async e => {
  const file = e.target.files[0]
  if (!file) return
  try {
    applyRates(await file.text())
  } catch (err) {
    loadedRateMap = null
    fileStatusEl.textContent = ''
    setStatus('File load error: ' + err.message, 'error')
    updateCalcBtn()
  }
})

document.getElementById('presetBtn').addEventListener('click', async () => {
  try {
    setStatus('Loading preset…')
    const text = await fetch('./testdata/saron-1999-06-30_2024-06-12.tsv').then(r => r.text())
    applyRates(text)
  } catch (err) {
    loadedRateMap = null
    fileStatusEl.textContent = ''
    setStatus('Preset load error: ' + err.message, 'error')
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
    const decimals = parseInt(document.getElementById('decimals').value, 10)

    const gpuCsv = formatCSV(output, rateArray, numDays, mode, decimals)
    const t2Gpu = performance.now()

    const t0Cpu = performance.now()
    const cpuCsv = cpuCompoundCSV(rateArray, numDays, mode, decimals)
    const t1Cpu = performance.now()

    setStatus(`Computing BigDecimal compound rates...`)
    await new Promise(r => setTimeout(r, 0))
    const t0Bd = performance.now()
    const bdCsv = bigDecimalCompoundCSV(rateArray, numDays, mode, decimals)
    const t1Bd = performance.now()

    setStatus(`Computing rational compound rates...`)
    await new Promise(r => setTimeout(r, 0))
    const t0R = performance.now()
    const rationalCsv = rationalCompoundCSV(rateArray, numDays, mode, decimals)
    const t1R = performance.now()

    const filename = makeFilename(startDate, userEndDate)
    lastGpuCsv = gpuCsv
    lastCpuCsv = cpuCsv
    lastBdCsv = bdCsv
    lastRationalCsv = rationalCsv
    lastFilename = filename

    populateDiff(rationalCsv, bdCsv, cpuCsv, gpuCsv)
    switchTab('diff')

    const gpuMs = (t1Gpu - t0Gpu).toFixed(0)
    const gpuFmtMs = (t2Gpu - t1Gpu).toFixed(0)
    const cpuMs = (t1Cpu - t0Cpu).toFixed(0)
    const bdMs = (t1Bd - t0Bd).toFixed(0)
    const rMs = (t1R - t0R).toFixed(0)
    const rows = totalOutputs.toLocaleString()
    const bdDiffs = diffLines.filter(d => !d.isHeader && d.bdDiffers).length
    const cpuDiffs = diffLines.filter(d => !d.isHeader && d.cpuDiffers).length
    const gpuDiffs = diffLines.filter(d => !d.isHeader && d.gpuDiffers).length

    setStatus(
      `<span class="stat-left">${rows} compound rates\nCPU-BD: ${bdDiffs} diff${bdDiffs !== 1 ? 's' : ''} \u00b7 CPU-f64: ${cpuDiffs} diff${cpuDiffs !== 1 ? 's' : ''} \u00b7 GPU-f32: ${gpuDiffs} diff${gpuDiffs !== 1 ? 's' : ''}</span>` +
      `<span class="stat-right">           Compute    Format\nCPU-R  ${rMs.padStart(8)} ms\nCPU-BD ${bdMs.padStart(8)} ms\nCPU-f64${cpuMs.padStart(8)} ms\nGPU-f32${gpuMs.padStart(8)} ms ${gpuFmtMs.padStart(8)} ms</span>`,
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

function populateDiff(rationalCsv, bdCsv, cpuCsv, gpuCsv) {
  const rRows = rationalCsv.split('\n')
  const bdRows = bdCsv.split('\n')
  const cpuRows = cpuCsv.split('\n')
  const gpuRows = gpuCsv.split('\n')
  const maxLen = Math.max(rRows.length, bdRows.length, cpuRows.length, gpuRows.length)
  diffLines = []
  for (let i = 0; i < maxLen; i++) {
    const r = rRows[i] ?? ''
    const b = bdRows[i] ?? ''
    const c = cpuRows[i] ?? ''
    const g = gpuRows[i] ?? ''
    diffLines.push({
      lineNum: i, rational: r, bd: b, cpu: c, gpu: g,
      bdDiffers: r !== b, cpuDiffers: r !== c, gpuDiffers: r !== g,
      isHeader: i === 0,
    })
  }
  renderDiff()
}

function renderDiff() {
  const hideCommon = document.getElementById('hideCommon').checked
  const showBd = document.getElementById('showBd').checked
  const showCpu = document.getElementById('showCpu').checked
  const showGpu = document.getElementById('showGpu').checked
  const hideDates = document.getElementById('hideDates').checked
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const stripDates = s => hideDates ? s.replace(/^.*,/, '') : s

  // Build dynamic grid columns
  const cols = ['48px', '1fr']
  if (showBd) cols.push('1fr')
  if (showCpu) cols.push('1fr')
  if (showGpu) cols.push('1fr')
  const gridCols = cols.join(' ')
  document.getElementById('diffHeader').style.gridTemplateColumns = gridCols
  diffViewEl.style.gridTemplateColumns = gridCols
  document.querySelector('.diff-actions').style.gridTemplateColumns = gridCols

  // Toggle header/action visibility
  document.getElementById('bdHdrCol').style.display = showBd ? '' : 'none'
  document.getElementById('cpuHdrCol').style.display = showCpu ? '' : 'none'
  document.getElementById('gpuHdrCol').style.display = showGpu ? '' : 'none'
  document.querySelector('.col-actions.bd-actions').style.display = showBd ? '' : 'none'
  document.querySelector('.col-actions.cpu-actions').style.display = showCpu ? '' : 'none'
  document.querySelector('.col-actions.gpu-actions').style.display = showGpu ? '' : 'none'

  const visible = diffLines.filter(d => {
    if (d.isHeader) return true
    if (!hideCommon) return true
    return (showBd && d.bdDiffers) || (showCpu && d.cpuDiffers) || (showGpu && d.gpuDiffers)
  })

  let numsHtml = ''
  let rHtml = ''
  let bdHtml = ''
  let cpuHtml = ''
  let gpuHtml = ''

  for (const d of visible) {
    const num = d.isHeader ? '&nbsp;' : d.lineNum
    const bdCls = !d.isHeader && d.bdDiffers ? 'diff-line changed' : 'diff-line'
    const cpuCls = !d.isHeader && d.cpuDiffers ? 'diff-line changed' : 'diff-line'
    const gpuCls = !d.isHeader && d.gpuDiffers ? 'diff-line changed' : 'diff-line'
    numsHtml += `<div class="diff-line diff-num">${num}</div>`
    rHtml += `<div class="diff-line">${esc(d.rational)}</div>`
    if (showBd) bdHtml += `<div class="${bdCls}">${esc(stripDates(d.bd))}</div>`
    if (showCpu) cpuHtml += `<div class="${cpuCls}">${esc(stripDates(d.cpu))}</div>`
    if (showGpu) gpuHtml += `<div class="${gpuCls}">${esc(stripDates(d.gpu))}</div>`
  }

  let html = `<div class="diff-nums-col">${numsHtml}</div>` +
    `<div class="diff-col">${rHtml}</div>`
  if (showBd) html += `<div class="diff-col">${bdHtml}</div>`
  if (showCpu) html += `<div class="diff-col">${cpuHtml}</div>`
  if (showGpu) html += `<div class="diff-col">${gpuHtml}</div>`
  diffViewEl.innerHTML = html
}

document.getElementById('hideCommon').addEventListener('change', renderDiff)
document.getElementById('hideDates').addEventListener('change', renderDiff)
document.getElementById('showBd').addEventListener('change', renderDiff)
document.getElementById('showCpu').addEventListener('change', renderDiff)
document.getElementById('showGpu').addEventListener('change', renderDiff)

// ========== Diff Actions ==========

document.getElementById('rationalDownloadBtn').addEventListener('click', () => {
  if (lastRationalCsv) downloadFile(lastRationalCsv, lastFilename.replace('saron-compound-', 'saron-compound-rational-'))
})

document.getElementById('rationalCopyBtn').addEventListener('click', () => {
  if (lastRationalCsv) navigator.clipboard.writeText(lastRationalCsv)
})

document.getElementById('gpuDownloadBtn').addEventListener('click', () => {
  if (lastGpuCsv) downloadFile(lastGpuCsv, lastFilename.replace('saron-compound-', 'saron-compound-gpu-f32-'))
})

document.getElementById('gpuCopyBtn').addEventListener('click', () => {
  if (lastGpuCsv) navigator.clipboard.writeText(lastGpuCsv)
})

document.getElementById('cpuDownloadBtn').addEventListener('click', () => {
  if (lastCpuCsv) downloadFile(lastCpuCsv, lastFilename.replace('saron-compound-', 'saron-compound-f64-'))
})

document.getElementById('cpuCopyBtn').addEventListener('click', () => {
  if (lastCpuCsv) navigator.clipboard.writeText(lastCpuCsv)
})

document.getElementById('bdDownloadBtn').addEventListener('click', () => {
  if (lastBdCsv) downloadFile(lastBdCsv, lastFilename.replace('saron-compound-', 'saron-compound-bd-'))
})

document.getElementById('bdCopyBtn').addEventListener('click', () => {
  if (lastBdCsv) navigator.clipboard.writeText(lastBdCsv)
})
