// Подбор рабочего способа получить Web MIDI в автоматическом Chromium:
// 1) playwright-chromium + grantPermissions с явным origin
// 2) системный Google Chrome (channel: 'chrome')
// После успеха — 20 секунд слушаем пианино.
import { chromium } from 'file:///home/oem/projects/critical-ui-flows/node_modules/playwright/index.mjs'

const URL = 'http://localhost:8737/index.html'
const LISTEN_MS = 90000
const ORIGIN = 'http://localhost:8737'

async function probe(label, launchOptions) {
    const browser = await chromium.launch(launchOptions)
    const context = await browser.newContext()
    await context.grantPermissions(['midi', 'midi-sysex'], { origin: ORIGIN })
    const page = await context.newPage()
    await page.goto(URL)
    const inputs = await page.evaluate(async () => {
        const access = await Promise.race([
            navigator.requestMIDIAccess({ sysex: false }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ])
        const names = []
        access.inputs.forEach((input) => names.push(input.name))
        return names
    })
    console.log(`[${label}] MIDI-входы: ${JSON.stringify(inputs)}`)
    return { browser, page, inputs }
}

const attempts = [
    ['chromium-headed', { headless: false }],
    ['system-chrome', { channel: 'chrome', headless: false }],
    ['chromium-headless', { headless: true }],
]

let run = null
for (const [label, options] of attempts) {
    try {
        const result = await probe(label, options)
        if (result.inputs.length) {
            run = result
            break
        }
        await result.browser.close()
    } catch (e) {
        console.log(`[${label}] не вышло: ${e.message.split('\n')[0]}`)
    }
}

if (!run) {
    console.log('=== E2E MIDI: ни один способ не дал входов ===')
    process.exit(1)
}

// Слушаем пианино
await run.page.evaluate(() => {
    window.__midiEvents = []
    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
        access.inputs.forEach((input) => {
            input.onmidimessage = (event) => window.__midiEvents.push([...event.data])
        })
    })
})
console.log('=== ИГРАЙТЕ НА ПИАНИНО (до 90 секунд, завершусь после первой ноты) ===')
// Выходим досрочно, как только пришло первое событие
let events = []
const deadline = Date.now() + LISTEN_MS
while (Date.now() < deadline) {
    await run.page.waitForTimeout(2000)
    events = await run.page.evaluate(() => window.__midiEvents)
    if (events.length) break
}
console.log(`События (${events.length}): ${JSON.stringify(events.slice(0, 60))}`)
await run.browser.close()
console.log(events.length ? '=== E2E MIDI: OK ===' : '=== E2E MIDI: входы есть, события не пришли ===')
