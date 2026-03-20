import { diffDays, plusDays } from './date-utils.mjs'
import { range, formattedRound } from './number-utils.mjs'

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

export function cpuCompoundCSV(rateArray, numDays, mode) {
	const lines = ['startDate,endDate,value']
	const end = numDays
	if (mode === 0) {
		const cr = compoundRate(rateArray, 0, end)
		lines.push(`${rateArray[cr[0]][0]},${rateArray[cr[1]][0]},${formattedRound(cr[2], 4)}`)
	} else if (mode === 1) {
		for (let offset = 0; offset < end; offset++) {
			const cr = compoundRate(rateArray, offset, offset + 1)
			lines.push(`${rateArray[cr[0]][0]},${rateArray[cr[1]][0]},${formattedRound(cr[2], 4)}`)
		}
	} else {
		for (let offset = 0; offset < end; offset++) {
			for (let edOffset = 0; edOffset < end - offset; edOffset++) {
				const cr = compoundRate(rateArray, offset, offset + edOffset + 1)
				lines.push(`${rateArray[cr[0]][0]},${rateArray[cr[1]][0]},${formattedRound(cr[2], 4)}`)
			}
		}
	}
	return lines.join('\n')
}
