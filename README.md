# SARON Compound Rate Calculator (Node.js, WebGPU CLI and HTML)

Node.js CLI scripts that calculate SARON compound interest rates from a TSV rate file. Two variants: CPU (f64) and GPU (WebGPU, f32 compensated accumulation).

## Shared Library

Common code lives in `scripts/lib/`:

### JavaScript modules

| Module               | Exports                                       |
|----------------------|-----------------------------------------------|
| `lib/date-utils.mjs`   | `localDate`, `diffDays`, `isoDate`, `plusDays`   |
| `lib/number-utils.mjs` | `round`, `formattedRound`, `range`               |
| `lib/rate-loader.mjs`  | `tsvParse`, `loadRates`, `fillRates`             |
| `lib/gpu-format.mjs`   | `df64ToF64`, `formatCSV`                         |

### WGSL shader parts

The GPU shader is assembled from three parts at runtime (`prefix + compoundRate + suffix`):

| File                          | Contents                                                     |
|-------------------------------|--------------------------------------------------------------|
| `lib/saron-prefix.wgsl`        | Buffer bindings, `Params` struct, df64 emulation library     |
| `lib/saron-compound-rate.wgsl` | `compoundRate()` function (compensated accumulation)         |
| `lib/saron-suffix.wgsl`        | `@compute` entry point `main()` with mode dispatch           |

Both the GPU CLI and the browser version (`index.html`) share these files. The browser's Monaco editor is pre-filled with `saron-compound-rate.wgsl` and can be edited live.

## CPU Version

```sh
node scripts/saron-compound.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates]
```

## GPU Version (WebGPU)

Requires the `webgpu` npm package (`npm install webgpu`).

```sh
node scripts/saron-compound-gpu.mjs <tsvPath> <startDate> <endDate> [all] [allStartDates] [shaderPath]
```

Provide a custom WGSL shader path as the last argument to replace the default `compoundRate()` function.

## Browser Version

Open `index.html` via a local HTTP server. The page loads a TSV file, runs the WebGPU compute shader, and downloads the CSV result. The `compoundRate` shader can be edited live in the Monaco editor.

## Parameters

| Parameter       | Description                                              |
|-----------------|----------------------------------------------------------|
| `tsvPath`       | Path to TSV file with `date` and `rate` columns          |
| `startDate`     | Start date (`YYYY-MM-DD`)                                |
| `endDate`       | End date (`YYYY-MM-DD`)                                  |
| `all`           | `true`/`false` — compute rates for all offsets (default: `false`) |
| `allStartDates` | `true`/`false` — compute rates for all start/end combinations (default: `false`) |

Output is CSV (`startDate,endDate,value`) written to stdout. Calculation time (ms) is written to stderr.

## Example

```sh
node scripts/saron-compound.mjs testdata/saron-rates2022.tsv 2022-01-03 2022-07-22 true true > output.csv
```

This produces 20,301 compound rate rows covering every start/end date combination within the range.

## Tests

### CPU test

```sh
node scripts/saron-compound.test.mjs
```

Runs the CPU CLI and verifies the output matches the reference file `testdata/saron-compound-2022-01-03_2022-07-22_2026_03_19-20_18.csv` exactly (20,302 lines).

### HTML / browser test

```sh
node scripts/saron-compound-html.test.mjs
```

Launches a headless Chrome via `puppeteer-core`, serves `saron-compound.html` over a local HTTP server, uploads the test TSV, runs the WebGPU calculation, and compares the CSV output against the same reference file. Allows up to 15 f32 boundary rounding differences.
