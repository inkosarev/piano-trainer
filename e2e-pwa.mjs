#!/usr/bin/env node
/* E2E-проверка PWA-обвязки: локальный сервер, манифест, service worker,
 * офлайн-запуск и регрессия desktop-потока с file:// .
 *
 * Запуск:  node e2e-pwa.mjs   (сервер serve.mjs поднимается сам)
 * Playwright берётся из соседнего проекта critical-ui-flows.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'file:///home/oem/projects/critical-ui-flows/node_modules/playwright/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8737;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = BASE;

async function isUp(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function startServer() {
  if (await isUp(BASE + '/index.html')) {
    console.log(`— сервер уже слушает ${BASE}, использую его`);
    return null;
  }
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], { stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    if (await isUp(BASE + '/index.html')) return child;
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('serve.mjs не поднялся за 5 с');
}

function watchErrors(page, sink) {
  page.on('pageerror', e => sink.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') sink.push('console: ' + m.text()); });
}

async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return await chromium.launch({ channel: 'chrome', headless: true });
  }
}

const browser = await launch();
let server = null;
const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`  ok  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

try {
  server = await startServer();

  /* --- 1. Статика: манифест, иконки, sw.js --- */
  await test('статика отдаётся с правильными MIME', async () => {
    const checks = [
      ['/manifest.webmanifest', 'application/manifest+json'],
      ['/sw.js', 'text/javascript'],
      ['/icons/icon-192.png', 'image/png'],
      ['/icons/icon-512.png', 'image/png'],
      ['/icons/icon-maskable-192.png', 'image/png'],
      ['/icons/icon-maskable-512.png', 'image/png'],
    ];
    for (const [p, mime] of checks) {
      const resp = await fetch(BASE + p);
      assert.equal(resp.status, 200, p);
      assert.ok(resp.headers.get('content-type').startsWith(mime), `${p}: ${resp.headers.get('content-type')}`);
    }
    const manifest = await (await fetch(BASE + '/manifest.webmanifest')).json();
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.length >= 4);
  });

  /* --- 2. Приложение: загрузка, логика, отсутствие ошибок --- */
  const context = await browser.newContext({ permissions: ['midi'] });
  const page = await context.newPage();
  const errors = [];
  watchErrors(page, errors);

  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await test('страница загружается без ошибок, __trainer на месте', async () => {
    assert.ok(await page.evaluate(() => !!window.__trainer));
    assert.equal(errors.length, 0, errors.join(' | '));
  });

  await test('верная нота засчитывается через __trainer', async () => {
    await page.evaluate(() => { localStorage.clear(); __trainer.start(); });
    const target = await page.evaluate(() => __trainer.state().target);
    assert.ok(target !== null, 'цель не сгенерирована');
    await page.evaluate(n => __trainer.press(n), target);
    await page.waitForTimeout(150);
    const stats = await page.evaluate(() => __trainer.state().stats);
    assert.equal(stats.correct, 1, JSON.stringify(stats));
  });

  await test('клик мышью по виртуальной клавише тоже засчитывается', async () => {
    await page.waitForTimeout(600); // ждём следующей ноты после прошлого зачёта
    const before = await page.evaluate(() => __trainer.state().stats.correct);
    const target = await page.evaluate(() => __trainer.state().target);
    assert.ok(target !== null, 'цель не сгенерирована');
    await page.click(`.kb .key[data-midi="${target}"]`);
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => __trainer.state().stats.correct);
    assert.equal(after, before + 1, `до: ${before}, после: ${after}`);
  });

  /* --- 3. Service worker --- */
  await test('service worker зарегистрирован и контролирует страницу', async () => {
    await page.evaluate(() => navigator.serviceWorker.register('sw.js'));
    const sw = await page.evaluate(() => navigator.serviceWorker.ready.then(r => ({ active: !!r.active })));
    assert.ok(sw.active);
    await page.reload({ waitUntil: 'load' });
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    assert.ok(controlled, 'после reload страница не под контролем SW');
  });

  await test('офлайн: приложение работает без сети', async () => {
    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: 'load' });
      assert.ok(await page.evaluate(() => !!window.__trainer && !!document.querySelector('#staffHost svg')),
        'офлайн страница не отрисовалась');
      await page.evaluate(() => __trainer.start());
      const target = await page.evaluate(() => __trainer.state().target);
      await page.evaluate(n => __trainer.press(n), target);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => __trainer.state().stats.correct), 1);
    } finally {
      await context.setOffline(false);
    }
  });
  await context.close();

  /* --- 4. Регрессия: file:// (desktop-поток без изменений) --- */
  await test('file:// по-прежнему работает, SW не мешает', async () => {
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    const errs = [];
    watchErrors(p2, errs);
    await p2.goto('file://' + path.join(HERE, 'index.html'), { waitUntil: 'load' });
    assert.ok(await p2.evaluate(() => !!window.__trainer));
    assert.equal(await p2.evaluate(() => navigator.serviceWorker.controller), null);
    assert.equal(errs.length, 0, errs.join(' | '));
    await ctx2.close();
  });
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}

console.log('\ne2e-pwa: ' + (process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'все проверки пройдены'));
for (const line of results) console.log(line);
