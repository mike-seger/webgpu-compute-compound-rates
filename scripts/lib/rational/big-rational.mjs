// Arbitrary-precision rational arithmetic using native BigInt.
// Port of the Java BigRational from Princeton CS.

function gcd(a, b) {
	if (a < 0n) a = -a
	if (b < 0n) b = -b
	while (b !== 0n) { const t = b; b = a % b; a = t }
	return a
}

export class BigRational {
	constructor(num, den = 1n) {
		if (typeof num === 'number') num = BigInt(num)
		if (typeof den === 'number') den = BigInt(den)
		if (den === 0n) throw new Error('Denominator is zero')
		if (den < 0n) { num = -num; den = -den }
		const g = gcd(num, den)
		this.num = num / g
		this.den = den / g
	}

	times(b) {
		return new BigRational(this.num * b.num, this.den * b.den)
	}

	plus(b) {
		return new BigRational(
			this.num * b.den + b.num * this.den,
			this.den * b.den,
		)
	}

	minus(b) {
		return new BigRational(
			this.num * b.den - b.num * this.den,
			this.den * b.den,
		)
	}

	divides(b) {
		return new BigRational(this.num * b.den, this.den * b.num)
	}

	// Convert to f64 string with given decimal places (rounding half-up).
	toFixed(decimals) {
		const neg = this.num < 0n
		let num = neg ? -this.num : this.num
		const scale = 10n ** BigInt(decimals + 1)
		const scaled = num * scale / this.den
		// round: add 5 then truncate last digit
		const rounded = (scaled + 5n) / 10n
		let s = rounded.toString().padStart(decimals + 1, '0')
		const intPart = s.slice(0, s.length - decimals) || '0'
		const fracPart = s.slice(s.length - decimals)
		const result = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
		return neg ? `-${result}` : result
	}

	toNumber() {
		return Number(this.num) / Number(this.den)
	}
}

BigRational.ZERO = new BigRational(0n)
BigRational.ONE = new BigRational(1n)

// Parse a decimal string like "-0.7021" into an exact BigRational.
export function parseRational(s) {
	s = s.trim()
	const dot = s.indexOf('.')
	if (dot < 0) return new BigRational(BigInt(s))
	const decimals = s.length - dot - 1
	const intStr = s.replace('.', '')
	return new BigRational(BigInt(intStr), 10n ** BigInt(decimals))
}
