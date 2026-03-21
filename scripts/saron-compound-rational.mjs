#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { diffDays, plusDays } from './lib/date-utils.mjs'
import { loadRates, fillRates } from './lib/rate-loader.mjs'
import { rationalCompoundCSV } from './lib/rational/rational-compound.mjs'

function usage() {
	console.error('Usage: saron-compound-rational.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates]')
	process.exit(1)
}

const args = process.argv.slice(2)
if (args.length < 3) usage()

const tsvPath = args[0]
const startDate = args[1]
const endDate = args[2]
const all = args[3] === 'true'
const allStartDates = args[4] === 'true'

const data = readFileSync(tsvPath, 'utf-8')
const rates = loadRates(data)
const rateMap = fillRates(rates)

// Validate
const dates = [...rateMap.keys()]
if (dates.length === 0) throw new Error('No rates found')
if (startDate < dates[0]) throw new Error('Start date before first rate: ' + dates[0])

let d = startDate
while (d < endDate) {
	if (!rateMap.has(d)) throw new Error('Missing rate for: ' + d)
	d = plusDays(d, 1)
}

const rateArray = [...rateMap.entries()].filter(([date]) => date >= startDate && date <= endDate)
const computedEnd = plusDays(rateArray[rateArray.length - 1][0], 1)
rateArray.push([computedEnd, { rate: '0.0', weight: 1 }])
const numDays = diffDays(startDate, computedEnd)

let mode
if (!all) mode = 0
else if (!allStartDates) mode = 1
else mode = 2

const t0 = performance.now()
const csv = rationalCompoundCSV(rateArray, numDays, mode)
const elapsed = performance.now() - t0
process.stderr.write(`${elapsed.toFixed(1)} ms\n`)
process.stdout.write(csv)
