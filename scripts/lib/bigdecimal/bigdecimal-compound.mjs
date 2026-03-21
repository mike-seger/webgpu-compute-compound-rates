// BigDecimal compound rate calculator.
// Avoids intermediate divisions to preserve precision: accumulates
// numerator and denominator as separate BigDecimal products, dividing
// only for the final result.

import { BigDecimal, BD_ONE, BD_36000 } from './big-decimal.mjs'

const RESULT_SCALE = 30
const RESCALE_EVERY = 30

// Parse rate string once and cache on the entry.
function prepareRates(rateArray) {
  for (const entry of rateArray) {
    if (entry[1]._bd === undefined) {
      entry[1]._bd = BigDecimal.parse(entry[1].rate)
    }
  }
}

// ---------- single compound rate (modes 0 & 1) ----------

function compoundRate(rateArray, start, end, decimals) {
  // Accumulate product as pNum / pDen (both BigDecimal).
  // factor_i = (rate_i * w_i + 36000) / 36000
  // product  = ∏ factor_i = ∏(rate_i*w_i+36000) / 36000^n
  let pNum = BD_ONE  // ∏ (rate*w + 36000)
  let pDen = BD_ONE  // 36000^n
  let i = start, steps = 0
  while (i < end) {
    const rw = rateArray[i][1]
    let w = rw.weight
    if (w > 1 && i + w >= end) w = end - i
    i += w
    const wBd = new BigDecimal(BigInt(w), 0)
    const num = rw._bd.mul(wBd).add(BD_36000) // rate*w + 36000
    pNum = pNum.mul(num)
    pDen = pDen.mul(BD_36000)
    if (++steps % RESCALE_EVERY === 0) {
      pNum = pNum.rescale(pNum.scale)
      pDen = pDen.rescale(pDen.scale)
    }
  }
  // result = (pNum/pDen - 1) * 36000 / days = (pNum - pDen) * 36000 / (pDen * days)
  const days = new BigDecimal(BigInt(end - start), 0)
  const rNum = pNum.sub(pDen).mul(BD_36000)
  const rDen = pDen.mul(days)
  return rNum.div(rDen, RESULT_SCALE).toFixed(decimals)
}

// ---------- mode-2 prefix-product approach ----------

function mode2(rateArray, N, decimals, lines) {
  for (let s = 0; s < N; s++) {
    let pNum = BD_ONE
    let pDen = BD_ONE
    let i = s
    let steps = 0
    while (i < N) {
      const rw = rateArray[i][1]
      const fw = rw.weight
      const maxW = Math.min(fw, N - i)

      for (let w = 1; w <= maxW; w++) {
        const e = i + w
        const wBd = new BigDecimal(BigInt(w), 0)
        const fNum = rw._bd.mul(wBd).add(BD_36000)
        const tNum = pNum.mul(fNum)
        const tDen = pDen.mul(BD_36000)
        const days = new BigDecimal(BigInt(e - s), 0)
        const rNum = tNum.sub(tDen).mul(BD_36000)
        const rDen = tDen.mul(days)
        lines.push(`${rateArray[s][0]},${rateArray[e][0]},${rNum.div(rDen, RESULT_SCALE).toFixed(decimals)}`)
      }

      // accumulate full-weight factor for next rate
      i += fw
      if (i < N) {
        const wBd = new BigDecimal(BigInt(fw), 0)
        const fNum = rw._bd.mul(wBd).add(BD_36000)
        pNum = pNum.mul(fNum)
        pDen = pDen.mul(BD_36000)
        if (++steps % RESCALE_EVERY === 0) {
          pNum = pNum.rescale(pNum.scale)
          pDen = pDen.rescale(pDen.scale)
        }
      }
    }
  }
}

// ---------- public entry point ----------

export function bigDecimalCompoundCSV(rateArray, numDays, mode, decimals = 4) {
  prepareRates(rateArray)
  const lines = ['startDate,endDate,value']
  const N = numDays

  if (mode === 0) {
    lines.push(`${rateArray[0][0]},${rateArray[N][0]},${compoundRate(rateArray, 0, N, decimals)}`)
  } else if (mode === 1) {
    for (let s = 0; s < N; s++)
      lines.push(`${rateArray[s][0]},${rateArray[s + 1][0]},${compoundRate(rateArray, s, s + 1, decimals)}`)
  } else {
    mode2(rateArray, N, decimals, lines)
  }
  return lines.join('\n')
}
