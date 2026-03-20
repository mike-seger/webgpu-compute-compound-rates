import { formattedRound } from './number-utils.mjs'

export function df64ToF64(output, idx) {
	return output[2 * idx] + output[2 * idx + 1]
}

export function formatCSV(output, rateArray, numDays, mode) {
	const lines = ['startDate,endDate,value']
	if (mode === 0) {
		lines.push(`${rateArray[0][0]},${rateArray[numDays][0]},${formattedRound(df64ToF64(output, 0), 4)}`)
	} else if (mode === 1) {
		for (let i = 0; i < numDays; i++) {
			lines.push(`${rateArray[i][0]},${rateArray[i + 1][0]},${formattedRound(df64ToF64(output, i), 4)}`)
		}
	} else {
		let idx = 0
		for (let offset = 0; offset < numDays; offset++) {
			for (let edOffset = 0; edOffset < numDays - offset; edOffset++) {
				lines.push(`${rateArray[offset][0]},${rateArray[offset + edOffset + 1][0]},${formattedRound(df64ToF64(output, idx), 4)}`)
				idx++
			}
		}
	}
	return lines.join('\n')
}
