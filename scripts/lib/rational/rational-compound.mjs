// Optimised rational compound rate calculator.
// Key gains over the naive BigRational version:
//   1. Raw BigInt numerator/denominator pairs — no GCD on every operation.
//   2. Prefix-product approach for mode 2 — O(N²) instead of O(N³).

const CF = 36000n
const REDUCE_EVERY = 30 // periodic GCD to limit digit growth

function gcd(a, b) {
	if (a < 0n) a = -a
	if (b < 0n) b = -b
	while (b !== 0n) { const t = b; b = a % b; a = t }
	return a
}

function reduce(n, d) {
	const g = gcd(n, d)
	return g === 1n ? [n, d] : [n / g, d / g]
}

// Matches BigRational.toFixed – half-up rounding on raw num/den.
function toFixedRaw(num, den, decimals) {
	let neg = num < 0n
	if (neg) num = -num
	const scale = 10n ** BigInt(decimals + 1)
	const scaled = num * scale / den
	const rounded = (scaled + 5n) / 10n
	if (rounded === 0n) neg = false
	let s = rounded.toString().padStart(decimals + 1, '0')
	const intPart = s.slice(0, s.length - decimals) || '0'
	const fracPart = s.slice(s.length - decimals)
	const result = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
	return neg ? `-${result}` : result
}

// Parse decimal string to [BigInt numerator, BigInt denominator].
function parseRate(s) {
	s = s.trim()
	const dot = s.indexOf('.')
	if (dot < 0) return [BigInt(s), 1n]
	const dec = s.length - dot - 1
	return [BigInt(s.replace('.', '')), 10n ** BigInt(dec)]
}

// Attach parsed BigInt num/den to each rate entry (once).
function prepareRates(rateArray) {
	for (const entry of rateArray) {
		if (entry[1].rnum === undefined) {
			const [n, d] = parseRate(entry[1].rate)
			entry[1].rnum = n
			entry[1].rden = d
		}
	}
}

// ---------- single compound rate (modes 0 & 1) ----------

function compoundRateRaw(rateArray, start, end, decimals) {
	let pn = 1n, pd = 1n
	let i = start, steps = 0
	while (i < end) {
		const rw = rateArray[i][1]
		let w = rw.weight
		if (w > 1 && i + w >= end) w = end - i
		i += w
		const wb = BigInt(w)
		// factor = rate·w/36000 + 1 = (rnum·w + rden·36000) / (rden·36000)
		pn *= rw.rnum * wb + rw.rden * CF
		pd *= rw.rden * CF
		if (++steps % REDUCE_EVERY === 0) [pn, pd] = reduce(pn, pd)
	}
	// result = (product − 1) · 36000 / totalDays
	const rn = (pn - pd) * CF
	const rd = pd * BigInt(end - start)
	return toFixedRaw(rn, rd, decimals)
}

// ---------- mode-2 prefix-product approach ----------

function mode2(rateArray, N, decimals, lines) {
	for (let s = 0; s < N; s++) {
		let pn = 1n, pd = 1n
		let i = s, steps = 0
		while (i < N) {
			const rw = rateArray[i][1]
			const fw = rw.weight
			const rnum = rw.rnum, rden = rw.rden
			const maxW = Math.min(fw, N - i)

			// Emit one result per sub-weight endpoint
			for (let w = 1; w <= maxW; w++) {
				const e = i + w
				const wb = BigInt(w)
				const fn = rnum * wb + rden * CF
				const fd = rden * CF
				const tn = pn * fn, td = pd * fd
				const rn = (tn - td) * CF
				const rd = td * BigInt(e - s)
				lines.push(`${rateArray[s][0]},${rateArray[e][0]},${toFixedRaw(rn, rd, decimals)}`)
			}

			// Accumulate full-weight factor for subsequent rates
			i += fw
			if (i < N) {
				pn *= rnum * BigInt(fw) + rden * CF
				pd *= rden * CF
				if (++steps % REDUCE_EVERY === 0) [pn, pd] = reduce(pn, pd)
			}
		}
	}
}

// ---------- public entry point ----------

export function rationalCompoundCSV(rateArray, numDays, mode, decimals = 4) {
	prepareRates(rateArray)
	const lines = ['startDate,endDate,value']
	const N = numDays

	if (mode === 0) {
		lines.push(`${rateArray[0][0]},${rateArray[N][0]},${compoundRateRaw(rateArray, 0, N, decimals)}`)
	} else if (mode === 1) {
		for (let s = 0; s < N; s++)
			lines.push(`${rateArray[s][0]},${rateArray[s + 1][0]},${compoundRateRaw(rateArray, s, s + 1, decimals)}`)
	} else {
		mode2(rateArray, N, decimals, lines)
	}
	return lines.join('\n')
}
