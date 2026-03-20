#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(__dirname, 'saron-compound.mjs')
const tsvPath = join(__dirname, '..', 'testdata', 'saron-rates2022.tsv')
const expectedPath = join(__dirname, '..', 'testdata', 'saron-compound-2022-01-03_2022-07-22_2026_03_19-20_18.csv')

console.log('Running saron-compound.mjs with test parameters...')

const actual = execFileSync('node', [
	scriptPath, tsvPath, '2022-01-03', '2022-07-22', 'true', 'true'
], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })

const expected = readFileSync(expectedPath, 'utf-8')

const actualLines = actual.split('\n')
const expectedLines = expected.split('\n')

assert.equal(actualLines.length, expectedLines.length,
	`Line count mismatch: got ${actualLines.length}, expected ${expectedLines.length}`)

let mismatches = 0
for (let i = 0; i < expectedLines.length; i++) {
	if (actualLines[i] !== expectedLines[i]) {
		if (mismatches < 10) {
			console.error(`Line ${i + 1} differs:`)
			console.error(`  expected: ${expectedLines[i]}`)
			console.error(`  actual:   ${actualLines[i]}`)
		}
		mismatches++
	}
}

assert.equal(mismatches, 0, `${mismatches} lines differ`)
console.log(`OK - all ${expectedLines.length} lines match`)
