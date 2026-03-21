// Fixed-point BigDecimal using BigInt.
// Value = unscaled * 10^(-scale).  Scale is always non-negative.

export class BigDecimal {
  constructor(unscaled, scale = 0) {
    this.unscaled = BigInt(unscaled)
    this.scale = scale
  }

  // Parse a decimal string like "1.454286" → BigDecimal(1454286, 6)
  static parse(s) {
    s = s.trim()
    const dot = s.indexOf('.')
    if (dot < 0) return new BigDecimal(BigInt(s), 0)
    const dec = s.length - dot - 1
    return new BigDecimal(BigInt(s.replace('.', '')), dec)
  }

  // Align two BigDecimals to the same scale (the larger one).
  static align(a, b) {
    if (a.scale === b.scale) return [a, b]
    if (a.scale > b.scale) {
      return [a, new BigDecimal(b.unscaled * 10n ** BigInt(a.scale - b.scale), a.scale)]
    }
    return [new BigDecimal(a.unscaled * 10n ** BigInt(b.scale - a.scale), b.scale), b]
  }

  add(other) {
    const [a, b] = BigDecimal.align(this, other)
    return new BigDecimal(a.unscaled + b.unscaled, a.scale)
  }

  sub(other) {
    const [a, b] = BigDecimal.align(this, other)
    return new BigDecimal(a.unscaled - b.unscaled, a.scale)
  }

  mul(other) {
    return new BigDecimal(
      this.unscaled * other.unscaled,
      this.scale + other.scale,
    )
  }

  // Divide with a target result scale (precision of the quotient).
  div(other, resultScale = 30) {
    const extra = resultScale - this.scale + other.scale
    let num = this.unscaled
    if (extra > 0) {
      num *= 10n ** BigInt(extra)
    } else if (extra < 0) {
      // Numerator has excess scale — remove it to avoid inflated result
      num /= 10n ** BigInt(-extra)
    }
    const q = num / other.unscaled
    return new BigDecimal(q, resultScale)
  }

  // Rescale to a smaller scale using half-up rounding.
  rescale(newScale) {
    if (newScale >= this.scale) {
      if (newScale === this.scale) return this
      return new BigDecimal(this.unscaled * 10n ** BigInt(newScale - this.scale), newScale)
    }
    const diff = BigInt(this.scale - newScale)
    const divisor = 10n ** diff
    let u = this.unscaled
    let neg = false
    if (u < 0n) { neg = true; u = -u }
    const rounded = (u + divisor / 2n) / divisor
    return new BigDecimal(neg ? -rounded : rounded, newScale)
  }

  // Format as string with exactly `decimals` fractional digits (half-up rounding).
  toFixed(decimals) {
    const r = this.rescale(decimals)
    let u = r.unscaled
    let neg = false
    if (u < 0n) { neg = true; u = -u }
    if (u === 0n) neg = false
    let s = u.toString().padStart(decimals + 1, '0')
    const intPart = s.slice(0, s.length - decimals) || '0'
    const fracPart = s.slice(s.length - decimals)
    const result = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
    return neg ? `-${result}` : result
  }
}

export const BD_ZERO = new BigDecimal(0n, 0)
export const BD_ONE = new BigDecimal(1n, 0)
export const BD_36000 = new BigDecimal(36000n, 0)
