// Test: sequential vs pairwise compensated accumulation in f32
import { readFileSync } from 'fs';

function f32(x) { return Math.fround(x); }

function formattedRound(n, decimals) {
  function round(n, d) {
    if (n < 0) return -round(-n, d);
    return +(Math.round(n + 'e+' + d) + 'e-' + d);
  }
  let s = round(round(n, decimals + 5), decimals) + '';
  if (s.indexOf('.') < 0) s += '.0';
  const length = s.indexOf('.') + 1 + decimals;
  return s.padEnd(length, '0');
}

// Load actual rates
const tsvPath = 'testdata/saron-rates2022.tsv';
const tsvData = readFileSync(tsvPath, 'utf-8');
const lines = tsvData.replaceAll('\r', '').split('\n').filter(l => l.match(/^\d{4}-/));
const rateEntries = lines.map(l => {
  const [d, r] = l.split('\t');
  return { date: d, rate: parseFloat(r) };
});

// Build rate map with weights (same logic as fillRates)
function isoDate(d) {
  return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
}
function localDate(s) {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}
function diffDays(a, b) {
  return Math.round((localDate(b).setHours(12) - localDate(a).setHours(12)) / 8.64e7);
}
function plusDays(s, n) {
  const d = localDate(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

const rateMap = new Map();
let prev = null;
rateEntries.sort((a,b) => a.date.localeCompare(b.date));
for (const obj of rateEntries) {
  if (prev) {
    const gap = diffDays(prev.date, obj.date) - 1;
    if (gap > 0) {
      prev.weight = gap + 1;
      let w = gap, off = 1;
      while (off <= gap) {
        rateMap.set(plusDays(prev.date, off++), { rate: prev.rate, weight: w-- });
      }
    }
  }
  const entry = { rate: obj.rate, weight: 1 };
  rateMap.set(obj.date, entry);
  prev = { date: obj.date, rate: obj.rate, weight: 1, rateWeight: entry };
}

// True FMA emulation: a*b is exact for f32 inputs (fits in f64), then add c, then round
function fma_f32(a, b, c) {
  return f32(a * b + c); // a*b exact in f64 for f32 inputs
}

// F32 Sequential compensated accumulation
function compoundSeq(rateArr, start, end) {
  let p = f32(0);
  for (let i = start; i < end; ) {
    let w = rateArr[i].weight;
    if (w > 1 && i + w >= end) w = end - i;
    const delta = f32(f32(f32(rateArr[i].rate) * f32(w)) / f32(36000));
    p = f32(f32(p + delta) + f32(p * delta));
    i += w;
  }
  return f32(f32(p * f32(36000)) / f32(end - start));
}

// F32 Pairwise with fma-based combine: fma(a, b, a+b) = a*b + (a+b) exactly
function compoundPairwiseFma(rateArr, start, end) {
  const stack = new Float32Array(16);
  const levels = new Uint32Array(16);
  let sp = -1;

  for (let i = start; i < end; ) {
    let w = rateArr[i].weight;
    if (w > 1 && i + w >= end) w = end - i;
    let delta = f32(f32(f32(rateArr[i].rate) * f32(w)) / f32(36000));
    let curLevel = 0;

    while (sp >= 0 && levels[sp] === curLevel) {
      const a = stack[sp];
      delta = fma_f32(a, delta, f32(a + delta)); // fma(a, delta, a+delta) = a*delta + (a+delta)
      curLevel++;
      sp--;
    }
    sp++;
    stack[sp] = delta;
    levels[sp] = curLevel;
    i += w;
  }

  while (sp > 0) {
    const b = stack[sp]; sp--;
    const a = stack[sp];
    stack[sp] = fma_f32(a, b, f32(a + b));
  }

  // fma-based output: capture error of p*36000
  const p = stack[0];
  const n = f32(end - start);
  const scaled = f32(p * f32(36000));
  const scaled_err = fma_f32(p, f32(36000), -scaled);
  // Return as hi + lo (simulating df64 output)
  return scaled / n + scaled_err / n;
}

// F64 reference
function compoundRef(rateArr, start, end) {
  let product = 1;
  for (let i = start; i < end; ) {
    let w = rateArr[i].weight;
    if (w > 1 && i + w >= end) w = end - i;
    product *= rateArr[i].rate * w / 36000 + 1;
    i += w;
  }
  return (product - 1) * 36000 / (end - start);
}

// Test the 15 failing cases
const failingCases = [
  ['2022-01-11', '2022-02-25'],
  ['2022-01-20', '2022-03-21'],
  ['2022-01-29', '2022-04-07'],
  ['2022-02-14', '2022-06-19'],
  ['2022-02-22', '2022-04-03'],
  ['2022-02-23', '2022-04-20'],
  ['2022-02-27', '2022-07-15'],
  ['2022-03-03', '2022-04-27'],
  ['2022-03-07', '2022-05-30'],
  ['2022-03-13', '2022-07-23'],
  ['2022-03-31', '2022-05-10'],
  ['2022-04-14', '2022-07-12'],
  ['2022-04-27', '2022-06-24'],
  ['2022-04-28', '2022-04-29'],
  ['2022-05-30', '2022-07-11'],
];

// Build rateArray for the full range
const startDate = '2022-01-03';
const endDateFull = '2022-07-22';
const dates = [...rateMap.keys()].filter(d => d >= startDate && d <= endDateFull).sort();
const endSentinel = plusDays(dates[dates.length - 1], 1);
const fullArr = dates.map(d => rateMap.get(d));
fullArr.push({ rate: 0, weight: 1 });
const dateArr = [...dates, endSentinel];

function dateIdx(d) { return dateArr.indexOf(d); }

// F32 Pairwise+fma+1day: with 1-day fast path returning rate directly
function compoundPairwise1day(rateArr, start, end) {
  if (end - start === 1) {
    // 1-day: return rate directly (as if df64 hi+lo pair from JS)
    return rateArr[start].rate; // use f64 rate, simulating df64 output
  }
  return compoundPairwiseFma(rateArr, start, end);
}

// Test the 15 failing cases
console.log('Case                         | f64 ref     | seq f32     | pw+1d f32    | seq ok | pw ok');
console.log('-'.repeat(95));
let seqWrong = 0, pwWrong = 0;
for (const [sd, ed] of failingCases) {
  const si = dateIdx(sd), ei = dateIdx(ed);
  const ref = compoundRef(fullArr, si, ei);
  const seq = compoundSeq(fullArr, si, ei);
  const pw = compoundPairwise1day(fullArr, si, ei);
  const refStr = formattedRound(ref, 4);
  const seqStr = formattedRound(seq, 4);
  const pwStr = formattedRound(pw, 4);
  const seqOk = seqStr === refStr ? ' YES ' : ' NO  ';
  const pwOk = pwStr === refStr ? ' YES ' : ' NO  ';
  if (seqStr !== refStr) seqWrong++;
  if (pwStr !== refStr) pwWrong++;
  console.log(`${sd} -> ${ed} | ${refStr.padStart(10)} | ${seqStr.padStart(10)} | ${pwStr.padStart(11)} | ${seqOk} | ${pwOk}`);
}
console.log(`\nSequential wrong: ${seqWrong}/15, Pairwise+1day wrong: ${pwWrong}/15`);

// === FULL comparison: all 20301 compounds ===
console.log('\n=== Full comparison (all compounds) ===');
let totalCompounds = 0, seqMiss = 0, pwMiss = 0;
const seqMisses = [], pwMisses = [];
for (let offset = 0; offset < dateArr.length - 1; offset++) {
  for (let edOff = 0; edOff < dateArr.length - 1 - offset; edOff++) {
    const si = offset, ei = offset + edOff + 1;
    const ref = compoundRef(fullArr, si, ei);
    const seq = compoundSeq(fullArr, si, ei);
    const pw = compoundPairwise1day(fullArr, si, ei);
    const refStr = formattedRound(ref, 4);
    if (formattedRound(seq, 4) !== refStr) {
      seqMiss++;
      if (seqMisses.length < 5) seqMisses.push(`${dateArr[si]}->${dateArr[ei]} seq=${formattedRound(seq,4)} ref=${refStr}`);
    }
    if (formattedRound(pw, 4) !== refStr) {
      pwMiss++;
      if (pwMisses.length < 5) pwMisses.push(`${dateArr[si]}->${dateArr[ei]} pw=${formattedRound(pw,4)} ref=${refStr}`);
    }
    totalCompounds++;
  }
}
console.log(`Total compounds: ${totalCompounds}`);
console.log(`Sequential f32 mismatches: ${seqMiss}`);
console.log(`Pairwise+1day f32 mismatches: ${pwMiss}`);
if (seqMisses.length) console.log('  Seq examples:', seqMisses.join('; '));
if (pwMisses.length) console.log('  PW examples:', pwMisses.join('; '));
