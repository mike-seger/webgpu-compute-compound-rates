#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { diffDays, plusDays } from './lib/date-utils.mjs'
import { range, formattedRound } from './lib/number-utils.mjs'
import { loadRates, fillRates } from './lib/rate-loader.mjs'

// --- SaronCompoundCalculator ---

function doValidateRateMap(rateMap, startDate, endDate) {
	let date = startDate
	while (date < endDate) {
		const rateWeight = rateMap.get(date)
		if (rateWeight == null) throw new Error('Missing rate for: ' + date)
		date = plusDays(date, 1)
	}
}

function compoundRate(rateArray, start, end) {
	let i = start
	let product = 1
	while (i < end) {
		const rateWeight = rateArray[i][1]
		let weight = rateWeight.weight
		if (weight > 1 && i + weight >= end)
			weight = end - i
		i = i + weight
		const factor = rateWeight.rate * weight / 36000.0 + 1
		product *= factor
	}

	const result = (product - 1) * 36000.0 / (end - start)
	return [start, end, result]
}

function compoundRateSeries(rateMap, startDate, endDate, all, allStartDates) {
	const compoundRates = []
	const dates = [...rateMap.keys()]
	doValidateRateMap(rateMap, startDate, endDate)
	if (dates.length === 0) throw new Error('No rates found')
	if (startDate >= endDate)
		throw new Error(`StartDate (${startDate}) must be before endDate (${endDate})`)
	if (startDate < dates[0])
		throw new Error('StartDate is before first rate date: ' + dates[0])
	if (plusDays(endDate, -10) > dates[dates.length - 1])
		throw new Error('EndDate is after last rate date: ' + dates[dates.length - 1])
	const rateArray = [...rateMap.entries()].filter(
		([date]) => date >= startDate && date <= endDate
	)

	endDate = plusDays(rateArray[rateArray.length - 1][0], 1)
	rateArray.push([endDate, { rate: '0.0', weight: 1 }])
	const end = diffDays(startDate, endDate)
	if (all)
		range(0, end).forEach(
			offset => {
				if (allStartDates)
					range(0, end - offset).forEach(edOffset => {
						const cr = compoundRate(rateArray, offset, offset + edOffset + 1)
						compoundRates.push(cr)
					})
				else compoundRates.push(compoundRate(rateArray, offset, offset + 1))
			}
		)
	else compoundRates.push(compoundRate(rateArray, 0, end))
	return { compoundRates, rateArray }
}

function formatResults(compoundRates, rateArray) {
	const compoundRatesResult = []
	compoundRates.forEach(cr => compoundRatesResult.push(
		{ startDate: rateArray[cr[0]][0], endDate: rateArray[cr[1]][0], value: formattedRound(cr[2], 4) }
	))
	return compoundRatesResult
}

// --- CLI ---

function usage() {
	console.error('Usage: saron-compound.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates]')
	console.error('')
	console.error('  tsvPath        Path to TSV file with date/rate columns')
	console.error('  startDate      Start date (YYYY-MM-DD)')
	console.error('  endDate        End date (YYYY-MM-DD)')
	console.error('  all            true/false (default: false)')
	console.error('  allStartDates  true/false (default: false)')
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
const t0 = performance.now()
const { compoundRates, rateArray } = compoundRateSeries(rateMap, startDate, endDate, all, allStartDates)
const elapsed = performance.now() - t0
process.stderr.write(`${elapsed.toFixed(1)} ms\n`)

const results = formatResults(compoundRates, rateArray)
const lines = ['startDate,endDate,value']
for (const r of results) {
	lines.push(`${r.startDate},${r.endDate},${r.value}`)
}
process.stdout.write(lines.join('\n'))
