#!/usr/bin/env node
import { loadRates, fillRates } from './lib/rate-loader.mjs'
import { cpuCompoundCSV } from './lib/f64/f64-compound.mjs'
import { diffDays, plusDays } from './lib/date-utils.mjs'
import { readFileSync } from 'fs'

const data = readFileSync('testdata/saron-rates2022.tsv', 'utf-8')
const rates = loadRates(data)
const rateMap = fillRates(rates)

// Exact params from screenshot: 2022-01-03 to 2023-01-14, decimals=6
const startDate = '2022-01-03', userEndDate = '2023-01-14'
const rateArray = [...rateMap.entries()].filter(([d]) => d >= startDate && d <= userEndDate)
const endDate = plusDays(rateArray[rateArray.length - 1][0], 1)
rateArray.push([endDate, { rate: '0.0', weight: 1 }])
const numDays = diffDays(startDate, endDate)

console.log('numDays:', numDays, 'total outputs:', numDays*(numDays+1)/2)

const csv = cpuCompoundCSV(rateArray, numDays, 2, 6)
const lines = csv.split('\n')
const nanLines = lines.filter(l => l.includes('NaN'))
console.log('CPU NaN lines:', nanLines.length)
if (nanLines.length > 0) nanLines.slice(0, 3).forEach(l => console.log('  ', l))

const target = lines.find(l => l.startsWith('2022-05-01,2023-01-02'))
console.log('Target line:', target)
