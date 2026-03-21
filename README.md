# SARON Compound Rate Calculator (Node.js, WebGPU CLI and HTML)

Four implementations of SARON compound interest rate calculation, from exact arithmetic to GPU compute:

| Engine   | Precision | Implementation |
|----------|-----------|----------------|
| CPU-R    | exact     | BigRational — arbitrary-precision rational using raw BigInt pairs |
| CPU-BD   | ~30 digits | BigDecimal — fixed-point arithmetic using BigInt |
| CPU-f64  | ~15 digits | Native JavaScript `number` (IEEE 754 f64) |
| GPU-f32  | ~7 digits  | WebGPU compute shader using f32 compensated accumulation |

CPU-R serves as the golden source; the browser diff view highlights where the other engines diverge.

## Project Structure

```
scripts/
├── saron-compound.mjs              # CPU-f64 CLI
├── saron-compound-gpu.mjs          # GPU-f32 CLI
├── saron-compound-rational.mjs     # CPU-R CLI
├── saron-compound-app.mjs          # Browser app (all 4 engines)
├── saron-compound.test.mjs         # CLI test
├── saron-compound-html.test.mjs    # Headless browser test
└── lib/
    ├── date-utils.mjs              # localDate, diffDays, isoDate, plusDays
    ├── number-utils.mjs            # round, formattedRound, range
    ├── rate-loader.mjs             # tsvParse, loadRates, fillRates
    ├── gpu-format.mjs              # df64ToF64, formatCSV
    ├── saron-compound.css          # Styles
    ├── saron-prefix.wgsl           # Buffer bindings, Params, df64 emulation
    ├── saron-compound-rate.wgsl    # compoundRate() — editable in Monaco
    ├── saron-suffix.wgsl           # @compute entry point with mode dispatch
    ├── rational/
    │   ├── big-rational.mjs        # BigRational class
    │   └── rational-compound.mjs   # rationalCompoundCSV()
    ├── bigdecimal/
    │   ├── big-decimal.mjs         # BigDecimal class
    │   └── bigdecimal-compound.mjs # bigDecimalCompoundCSV()
    └── f64/
        └── f64-compound.mjs        # cpuCompoundCSV()
```

## CLI Scripts

All CLI scripts output CSV (`startDate,endDate,value`) to stdout and timing (ms) to stderr.

### CPU-f64

```sh
node scripts/saron-compound.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates]
```

### CPU-R (BigRational)

```sh
node scripts/saron-compound-rational.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates]
```

### GPU-f32 (WebGPU)

Requires the `webgpu` npm package (`npm install webgpu`).

```sh
node scripts/saron-compound-gpu.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates] [shaderPath]
```

Provide a custom WGSL shader path as the last argument to replace the default `compoundRate()` function.

### Parameters

| Parameter       | Description                                              |
|-----------------|----------------------------------------------------------|
| `tsvPath`       | Path to TSV file with `date` and `rate` columns          |
| `startDate`     | Start date (`YYYY-MM-DD`)                                |
| `endDate`       | End date (`YYYY-MM-DD`)                                  |
| `all`           | `true`/`false` — compute rates for all offsets (default: `false`) |
| `allStartDates` | `true`/`false` — compute rates for all start/end combinations (default: `false`) |

### Example

```sh
node scripts/saron-compound.mjs testdata/saron-rates2022.tsv 2022-01-03 2022-07-22 true true > output.csv
```

Produces 20,301 compound rate rows covering every start/end date combination within the range.

## Browser Version

Open `index.html` via a local HTTP server (e.g. `just serve`). The page runs all four engines and shows results in a side-by-side diff view.

Features:
- **File input** or **"1999–2024" preset** button to load SARON rates
- **Decimals** dropdown (0–9, default 4)
- **Editable shader** — Monaco editor pre-filled with `compoundRate()`, changes apply on next Calculate
- **4-column diff view** — CPU-R (golden) vs CPU-BD, CPU-f64, GPU-f32
- **Column toggles** — show/hide CPU-BD, CPU-f64, GPU-f32 columns
- **Hide common** — show only rows where at least one engine differs
- **Hide dates** — strip startDate/endDate from non-golden columns for compact comparison
- **Per-column download/copy** — export any engine's CSV independently
- **Stats** — compound rate count, diff counts per engine, compute + format timing

## WGSL Shader

The GPU shader is assembled from three parts at runtime (`prefix + compoundRate + suffix`):

| File                          | Contents                                                     |
|-------------------------------|--------------------------------------------------------------|
| `lib/saron-prefix.wgsl`        | Buffer bindings, `Params` struct, df64 emulation library     |
| `lib/saron-compound-rate.wgsl` | `compoundRate()` function (compensated accumulation, f32)    |
| `lib/saron-suffix.wgsl`        | `@compute @workgroup_size(256)` entry point with mode dispatch |

The prefix includes df64 (double-f32) emulation helpers (`twoSum`, `twoProd`, `df64_add`, `df64_mul`, `df64_div`) providing ~48-bit mantissa precision, though the default `compoundRate()` kernel uses plain f32 arithmetic.

## Computation Modes

| Mode | Outputs | Description |
|------|---------|-------------|
| 0    | 1       | Single compound rate for startDate → endDate |
| 1    | N       | Daily compound rates (all offsets from startDate) |
| 2    | N×(N+1)/2 | All start/end date combinations (triangular enumeration) |

## Tests

### CLI test

```sh
node scripts/saron-compound.test.mjs
```

Verifies the CPU-f64 CLI output matches the reference file `testdata/saron-compound-2022-01-03_2022-07-22_2026_03_19-20_18.csv` exactly (20,302 lines).

### Browser test

```sh
node scripts/saron-compound-html.test.mjs
```

Launches headless Chrome via `puppeteer-core`, serves `index.html`, uploads the test TSV, runs all four engines, and compares against the reference file.
