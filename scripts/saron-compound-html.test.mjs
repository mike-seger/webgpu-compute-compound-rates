#!/usr/bin/env node

// Headless browser test for saron-compound.html (WebGPU version)
// Requires: puppeteer-core, system Chrome
// Usage: node scripts/saron-compound-html.test.mjs

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const projectRoot = resolve(__dirname, '..')

// --- Simple static file server ---

const MIME = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.tsv': 'text/tab-separated-values',
	'.csv': 'text/csv',
	'.wgsl': 'text/plain',
	'.webmanifest': 'application/manifest+json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
}

function startServer() {
	return new Promise((resolveP) => {
		const server = createServer((req, res) => {
			const safePath = req.url.split('?')[0].replace(/\.\./g, '')
			const filePath = resolve(projectRoot, '.' + safePath)
			if (!filePath.startsWith(projectRoot)) {
				res.writeHead(403)
				res.end()
				return
			}
			try {
				const data = readFileSync(filePath)
				const ext = extname(filePath)
				res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
				res.end(data)
			} catch {
				res.writeHead(404)
				res.end('Not found')
			}
		})
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port
			resolveP({ server, port })
		})
	})
}

// --- Find Chrome ---

function findChrome() {
	const candidates = [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium-browser',
		'/usr/bin/chromium',
	]
	for (const c of candidates) {
		try { readFileSync(c); return c } catch {}
	}
	throw new Error('Chrome not found. Install Chrome or set CHROME_PATH env var.')
}

// --- Main test ---

async function main() {
	const refPath = resolve(projectRoot, 'testdata/saron-compound-2022-01-03_2022-07-22_2026_03_19-20_18.csv')
	const tsvPath = resolve(projectRoot, 'testdata/saron-rates2022.tsv')
	const reference = readFileSync(refPath, 'utf-8').trimEnd()
	const refLines = reference.split('\n')

	console.log(`Reference: ${refLines.length} lines`)
	console.log('Starting HTTP server...')
	const { server, port } = await startServer()
	const baseUrl = `http://127.0.0.1:${port}`
	console.log(`Server listening on ${baseUrl}`)

	let browser
	let exitCode = 0
	try {
		const chromePath = process.env.CHROME_PATH || findChrome()
		console.log(`Launching Chrome: ${chromePath}`)

		browser = await puppeteer.launch({
			executablePath: chromePath,
			headless: 'new',
			args: [
				'--enable-unsafe-webgpu',
				'--enable-features=Vulkan',
				'--disable-gpu-sandbox',
				'--no-sandbox',
			],
		})

		const page = await browser.newPage()

		// Collect console messages for debugging
		const consoleLogs = []
		page.on('console', msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))
		page.on('pageerror', err => consoleLogs.push(`[error] ${err.message}`))

		console.log('Navigating to index.html...')
		await page.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 })

		// Check WebGPU availability
		const hasWebGPU = await page.evaluate(() => !!navigator.gpu)
		if (!hasWebGPU) {
			console.error('SKIP - WebGPU not available in this Chrome/environment')
			console.error('Console:', consoleLogs.join('\n'))
			exitCode = 2
			throw new Error('WebGPU not available')
		}
		console.log('WebGPU available')

		// Upload TSV file
		console.log('Uploading TSV file...')
		const fileInput = await page.$('#tsvFile')
		await fileInput.uploadFile(tsvPath)

		// Wait for file to be loaded
		await page.waitForFunction(
			() => document.getElementById('calcBtn').disabled === false,
			{ timeout: 10000 }
		)

		const fileStatus = await page.$eval('#fileStatus', el => el.textContent)
		console.log(`File status: ${fileStatus}`)

		// Dates and checkboxes should already be correct (defaults match test params)
		const startDate = await page.$eval('#startDate', el => el.value)
		const endDate = await page.$eval('#endDate', el => el.value)
		const allChecked = await page.$eval('#all', el => el.checked)
		const allSDChecked = await page.$eval('#allStartDates', el => el.checked)
		console.log(`Params: ${startDate} to ${endDate}, all=${allChecked}, allStartDates=${allSDChecked}`)

		// Intercept the download by overriding downloadFile before clicking Calculate
		await page.evaluate(() => {
			window.__testCSV = null
			// Override the Blob/URL download mechanism
			const origCreateObjectURL = URL.createObjectURL
			URL.createObjectURL = function(blob) {
				// Read blob content
				const reader = new FileReader()
				reader.onload = () => { window.__testCSV = reader.result }
				reader.readAsText(blob)
				return origCreateObjectURL.call(URL, blob)
			}
		})

		// Click Calculate
		console.log('Clicking Calculate...')
		await page.click('#calcBtn')

		// Wait for completion (status contains "Done")
		await page.waitForFunction(
			() => {
				const s = document.getElementById('status')
				return s.textContent.includes('Done') || s.classList.contains('error')
			},
			{ timeout: 120000 }
		)

		const statusText = await page.$eval('#status', el => el.textContent)
		const isError = await page.$eval('#status', el => el.classList.contains('error'))

		if (isError) {
			console.error('FAIL - Calculation error:')
			console.error(statusText)
			if (consoleLogs.length) console.error('Console:', consoleLogs.join('\n'))
			throw new Error('Calculation failed')
		}

		console.log(statusText.split('\n').filter(l => l.startsWith('GPU') || l.startsWith('CSV') || l.startsWith('Done')).join('\n'))

		// Wait for the CSV to be captured
		await page.waitForFunction(() => window.__testCSV !== null, { timeout: 5000 })
		const csv = await page.evaluate(() => window.__testCSV)

		if (!csv) {
			throw new Error('No CSV output captured')
		}

		const csvLines = csv.trimEnd().split('\n')
		console.log(`Output: ${csvLines.length} lines`)

		// Compare
		if (csvLines.length !== refLines.length) {
			throw new Error(`Line count mismatch: got ${csvLines.length}, expected ${refLines.length}`)
		}

		// Count differences (expect ≤15 from f32 boundary rounding)
		let diffs = 0
		const diffDetails = []
		for (let i = 0; i < refLines.length; i++) {
			if (csvLines[i] !== refLines[i]) {
				diffs++
				if (diffDetails.length < 5) {
					diffDetails.push(`  line ${i + 1}: got "${csvLines[i]}" expected "${refLines[i]}"`)
				}
			}
		}

		if (diffs === 0) {
			console.log(`OK - all ${refLines.length} lines match exactly`)
		} else if (diffs <= 15) {
			console.log(`OK - ${refLines.length} lines, ${diffs} f32 boundary differences (≤15 expected)`)
			diffDetails.forEach(d => console.log(d))
		} else {
			diffDetails.forEach(d => console.error(d))
			throw new Error(`${diffs} differences (expected ≤15)`)
		}

	} catch (err) {
		if (!exitCode) exitCode = 1
		console.error('FAIL -', err.message)
	} finally {
		if (browser) {
			const pid = browser.process()?.pid
			if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
		}
		server.closeAllConnections()
		server.close()
	}
	return exitCode
}

main().then(
	(code) => process.exit(code),
	() => process.exit(1),
)
// Hard failsafe in case cleanup hangs
setTimeout(() => process.exit(0), 5000).unref()
