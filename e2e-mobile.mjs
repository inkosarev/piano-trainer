#!/usr/bin/env node
/* E2E-проверка мобильного UI: эмуляция телефона (Pixel 7, тач-экран).
 *
 * 1) тап по виртуальной клавише засчитывается как нажатая нота;
 * 2) аккорд играется тремя пальцами одновременно (мультитач, зачёт блоком);
 * 3) страница не шире экрана, селекты 16px, кнопка установки скрыта.
 *
 * Запуск:  node e2e-mobile.mjs   (сервер serve.mjs поднимается сам)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, devices } from 'file:///home/oem/projects/critical-ui-flows/node_modules/playwright/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8737';

async function isUp(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function startServer() {
  if (await isUp(BASE + '/index.html')) return null;
  const child = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], { stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    if (await isUp(BASE + '/index.html')) return child;
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('serve.mjs не поднялся за 5 с');
}

async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return await chromium.launch({ channel: 'chrome', headless: true });
  }
}

/** Центры клавиш для списка MIDI-нот: [{midi, x, y}].
 *  Клавиатура на телефоне ниже первого экрана и может быть шире карточки —
 *  сначала прокручиваем ВСЕ клавиши в кадр (по вертикали и горизонтали),
 *  только потом измеряем координаты: каждый scrollIntoView сдвигает
 *  прокрутку и обесценивает ранее снятые координаты. */
async function keyPoints(page, midis) {
  return page.evaluate((ns) => {
    const els = ns.map(n => document.querySelector(`.kb .key[data-midi="${n}"]`));
    els.forEach(el => el && el.scrollIntoView({ block: 'center', inline: 'center' }));
    return ns.map((n, i) => {
      const el = els[i];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { midi: n, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  }, midis);
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
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());

  await test('страница умещается по ширине телефона, ошибок нет', async () => {
    assert.equal(errors.length, 0, errors.join(' | '));
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `горизонтальный скролл страницы: +${overflow}px`);
  });

  await test('клавиатура адаптивна: без скролла, клавиши крупнее 28px', async () => {
    const kb = await page.evaluate(() => {
      const card = document.querySelector('.kb-card');
      const key = document.querySelector('.kb .key.w');
      return {
        scroll: card.scrollWidth - card.clientWidth,
        keyW: key ? key.getBoundingClientRect().width : 0,
        touchAction: getComputedStyle(document.getElementById('keyboard')).touchAction
      };
    });
    assert.ok(kb.scroll <= 1, `горизонтальный скролл клавиатуры: +${kb.scroll}px`);
    assert.ok(kb.keyW >= 28, `белая клавиша узкая: ${kb.keyW.toFixed(1)}px`);
    assert.equal(kb.touchAction, 'none', 'touch-action должен быть none, когда клавиатура помещается');
    // статистика: ровные полные ряды (4 + 3), оба до правого края
    const rows = await page.evaluate(() => {
      const stats = document.querySelector('.stats');
      const sRight = stats.getBoundingClientRect().right;
      const byTop = new Map();
      document.querySelectorAll('.stats .tile').forEach(t => {
        const top = Math.round(t.getBoundingClientRect().top);
        if (!byTop.has(top)) byTop.set(top, []);
        byTop.get(top).push(t.getBoundingClientRect());
      });
      return Array.from(byTop.values()).map(rs => ({
        count: rs.length,
        equal: rs.every(r => Math.abs(r.width - rs[0].width) < 2),
        flush: Math.abs(rs[rs.length - 1].right - sRight) < 2
      }));
    });
    assert.equal(rows.length, 2, 'статистика должна занимать два ряда');
    assert.deepEqual(rows.map(r => r.count), [4, 3], 'ряды статистики: 4 + 3');
    assert.ok(rows.every(r => r.equal && r.flush), 'ряды статистики неровные: ' + JSON.stringify(rows));
  });

  await test('порядок блоков: нотоносец → клавиатура → статистика', async () => {
    const layout = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const kb = document.querySelector('.kb-card');
      const stats = document.querySelector('.stats');
      const after = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        order: after(stage, kb) && after(kb, stats),
        resetInSettings: !!document.getElementById('resetBtn').closest('.settings'),
        startInControls: !!document.getElementById('startBtn').closest('.controls')
      };
    });
    assert.ok(layout.order, 'порядок секций неверный');
    assert.ok(layout.resetInSettings, '«Сброс статистики» не в настройках');
    assert.ok(layout.startInControls, '«Начать» не в строке управления');
  });

  await test('тап по клавише = нажатая нота (Pointer Events)', async () => {
    await page.tap('#startBtn');
    const target = await page.evaluate(() => __trainer.state().target);
    assert.ok(target !== null);
    const [pt] = await keyPoints(page, [target]);
    assert.ok(pt, 'нет клавиши для ноты ' + target);
    await page.touchscreen.tap(pt.x, pt.y);
    await page.waitForTimeout(150);
    // подсветка нажатия/зачёта обязана дожить до отрисовки (быстрый тап — тоже)
    const rightAfter = await page.evaluate(() => ({
      on: document.querySelectorAll('.kb .on').length,
      correct: document.querySelectorAll('.kb .correct').length,
      wrong: document.querySelectorAll('.kb .wrong').length
    }));
    const stats = await page.evaluate(() => __trainer.state().stats);
    await page.tap('#startBtn'); // стоп — до проверок, чтобы не оставить сессию висеть
    assert.equal(stats.correct, 1, JSON.stringify(stats));
    assert.ok(rightAfter.on + rightAfter.correct + rightAfter.wrong >= 1,
      'после тапа нет видимой подсветки клавиши: ' + JSON.stringify(rightAfter));
    await page.waitForTimeout(650); // дольше минимальной подсветки (200мс) и метки зачёта (600мс)
    const stuck = await page.evaluate(() =>
      document.querySelectorAll('.kb .on, .kb .correct, .kb .wrong').length);
    assert.equal(stuck, 0, 'клавиша осталась подсвеченной после тапа');
  });

  await test('аккорд тремя пальцами засчитывается блоком', async () => {
    await page.tap('[data-mode="chords"]');
    await page.tap('#startBtn');
    await page.waitForTimeout(500); // ждём автопрокрутку клавиатуры к аккорду
    const chord = await page.evaluate(() => __trainer.state().chord);
    assert.ok(chord, 'аккорд не сгенерирован');
    const pts = await keyPoints(page, chord.notes);
    assert.ok(pts.every(Boolean), 'не все ноты аккорда есть на клавиатуре: ' + JSON.stringify(chord.notes));

    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.midi })),
    });
    await page.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);

    const stats = await page.evaluate(() => __trainer.state().stats);
    assert.equal(stats.correct, 1, JSON.stringify(stats));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.kb .on').length), 0);
  });

  await test('аккорд без MIDI набирается тапами по очереди', async () => {
    if (await page.evaluate(() => __trainer.state().running)) await page.tap('#startBtn');
    await page.tap('#startBtn');
    await page.waitForTimeout(500); // ждём автопрокрутку клавиатуры к аккорду
    const chord = await page.evaluate(() => __trainer.state().chord);
    assert.ok(chord, 'аккорд не сгенерирован');
    const pts = await keyPoints(page, chord.notes);
    assert.ok(pts.every(Boolean), 'не все клавиши аккорда найдены: ' + JSON.stringify(chord.notes));
    // тапаем ноты аккорда по одной — зачёт без MIDI должен принимать набор по очереди
    for (const p of pts) {
      await page.touchscreen.tap(p.x, p.y);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(100);
    const stats = await page.evaluate(() => __trainer.state().stats);
    assert.equal(stats.correct, 1, 'аккорд тапами по очереди не зачтён: ' + JSON.stringify(stats));
    await page.tap('#startBtn'); // стоп
  });

  await test('ландшафт: две колонки, стан по центру, статистика в одну строку', async () => {
    const land = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 915, height: 412 } });
    const p = await land.newPage();
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await p.evaluate(() => localStorage.clear());
    const m = await p.evaluate(() => {
      const vh = window.innerHeight;
      const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
      const stage = rect('#stage');
      const svg = rect('#staffHost svg');
      const kb = rect('.kb-card');
      const stats = rect('.stats');
      const tiles = Array.from(document.querySelectorAll('.stats .tile'))
        .map(t => Math.round(t.getBoundingClientRect().top));
      return {
        vh,
        gridCols: getComputedStyle(document.querySelector('main')).gridTemplateColumns.split(' ').length,
        stageBottom: stage.bottom,
        centered: Math.abs((svg.left + svg.right) / 2 - (stage.left + stage.right) / 2),
        vCentered: Math.abs((svg.top + svg.bottom) / 2 - (stage.top + stage.bottom) / 2),
        overlayAlign: getComputedStyle(document.getElementById('idleOverlay')).alignItems,
        svgBottomGap: stage.bottom - svg.bottom,
        svgW: svg.width,
        kbBottom: kb.bottom,
        statsTop: stats.top,
        statsRows: new Set(tiles).size,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    assert.equal(m.gridCols, 2, 'ландшафт должен быть в две колонки');
    assert.ok(m.stageBottom <= m.vh, `стан вылезает за экран: ${m.stageBottom} > ${m.vh}`);
    assert.ok(m.centered <= 12, `нотный стан смещён от центра карточки на ${m.centered}px`);
    assert.ok(m.vCentered <= 8, `нотный стан смещён по вертикали на ${m.vCentered}px`);
    assert.equal(m.overlayAlign, 'flex-start', 'подсказка простоя должна быть у верхнего края');
    assert.ok(m.svgBottomGap >= 6, `стан наезжает на нижний край карточки: зазор ${m.svgBottomGap}px`);
    // SVG обязан масштабироваться под карточку (натуральный размер 260×190)
    assert.ok(Math.abs(m.svgW - 260) > 4, `SVG нотоносца не масштабируется: ${m.svgW}px`);
    assert.ok(m.kbBottom <= m.vh, `клавиатура за экраном: ${m.kbBottom} > ${m.vh}`);
    assert.ok(m.statsTop < m.vh, 'статистика не на экране');
    assert.equal(m.statsRows, 1, 'статистика не в одну строку');
    assert.ok(m.overflow <= 1, `горизонтальный скролл: +${m.overflow}px`);
    await land.close();
  });

  await test('мобильные детали: селекты 16px, кнопка установки скрыта', async () => {
    const fs = await page.evaluate(() => getComputedStyle(document.getElementById('midiSelect')).fontSize);
    assert.equal(fs, '16px', 'селект ' + fs);
    const hidden = await page.evaluate(() => document.getElementById('installBtn').hidden);
    assert.ok(hidden, 'кнопка установки видна без beforeinstallprompt');
  });

  await test('кнопка полного экрана работает', async () => {
    const supported = await page.evaluate(() =>
      !!document.documentElement.requestFullscreen && !!document.exitFullscreen);
    if (!supported) return; // окружение без Fullscreen API — кнопка скрыта, это норма
    await page.tap('#fsBtn');
    await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 3000 });
    const label = await page.evaluate(() => document.getElementById('fsBtn').textContent);
    await page.tap('#fsBtn');
    await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 3000 });
    assert.equal(label, 'Оконный режим');
  });

  await test('широкий диапазон: автопрокрутка к ноте и панорамирование пальцем', async () => {
    if (await page.evaluate(() => __trainer.state().running)) await page.tap('#startBtn');
    await page.evaluate(() => {
      document.querySelector('[data-mode="notes"]').click();
      document.querySelector('input[name="rangePreset"][value="wide"]').click();
    });
    await page.tap('#startBtn');
    const target = await page.evaluate(() => __trainer.state().target);
    assert.ok(target !== null);
    await page.waitForTimeout(700); // ждём smooth-прокрутку к целевой ноте
    const m = await page.evaluate((midi) => {
      const card = document.querySelector('.kb-card');
      const cr = card.getBoundingClientRect();
      const key = document.querySelector(`.kb .key[data-midi="${midi}"]`);
      const kr = key.getBoundingClientRect();
      return {
        pan: getComputedStyle(document.getElementById('keyboard')).touchAction,
        scrollable: card.scrollWidth > card.clientWidth,
        visible: kr.left >= cr.left - 1 && kr.right <= cr.right + 1
      };
    }, target);
    assert.ok(m.scrollable, 'при широком диапазоне клавиатура должна быть шире карточки');
    assert.equal(m.pan, 'pan-x', 'touch-action должен разрешать панорамирование');
    assert.ok(m.visible, 'целевая клавиша не в кадре после автопрокрутки');
    await page.tap('#startBtn'); // стоп
  });

  await test('промотка пальцем не играет ноту (тап — играет)', async () => {
    await page.tap('#startBtn');
    await page.waitForTimeout(500); // автопрокрутка к ноте
    const before = await page.evaluate(() => ({
      correct: __trainer.state().stats.correct,
      wrong: __trainer.state().stats.wrong
    }));
    const pt = await page.evaluate(() => {
      const key = document.querySelector('.kb .key.w');
      key.scrollIntoView({ block: 'center', inline: 'center' });
      const r = key.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pt.x - 130, y: pt.y }] });
    await page.waitForTimeout(250); // дольше задержки распознавания жеста (110мс)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => ({
      correct: __trainer.state().stats.correct,
      wrong: __trainer.state().stats.wrong,
      on: document.querySelectorAll('.kb .on').length
    }));
    assert.equal(after.correct, before.correct, 'промотка засчитала верную ноту');
    assert.equal(after.wrong, before.wrong, 'промотка засчитала ошибку');
    assert.equal(after.on, 0, 'клавиша осталась подсвеченной после промотки');
    await page.tap('#startBtn'); // стоп
  });

  await context.close();
} finally {
  await browser.close().catch(() => {});
  if (server) server.kill();
}

console.log('\ne2e-mobile: ' + (process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'все проверки пройдены'));
for (const line of results) console.log(line);
