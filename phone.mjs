#!/usr/bin/env node
/* Подключение телефона одной командой: сервер + проброс порта + Chrome.
 *
 *   node phone.mjs                 # всё автоматически
 *   node phone.mjs --no-open       # не открывать Chrome на телефоне
 *   node phone.mjs --serial <id>   # если к adb подключено несколько устройств
 *
 * Что делает:
 *   1. проверяет adb и телефон (ждёт подключения, подсказывает, что не так);
 *   2. поднимает serve.mjs на 127.0.0.1:8737, если он ещё не поднят;
 *   3. adb reverse tcp:8737 tcp:8737 — на телефоне появляется
 *      http://localhost:8737 (защищённый контекст: Web MIDI + установка PWA);
 *   4. открывает страницу в Chrome на телефоне;
 *   5. следит за переподключением USB и восстанавливает проброс
 *      (binding слетает при каждом переподключении кабеля).
 *
 * Ctrl+C — остановить сервер и убрать проброс.
 *
 * После установки приложения (PWA) телефон больше не нужен компьютеру:
 * приложение работает офлайн, пианино подключается к самому телефону (USB-OTG).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8737);

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}
const SERIAL_ARG = argValue('--serial') || process.env.ANDROID_SERIAL || null;
const NO_OPEN = args.includes('--no-open');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- запуск коротких команд ---------- */

function run(cmd, argv, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* уже завершился */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ code: null, out, err, timeout: true }), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: null, out, err, error: e }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

async function adb(argv, opts) {
  const res = await run('adb', argv, opts);
  if (res.error && res.error.code === 'ENOENT') {
    console.error('adb не найден. Установите:  sudo apt install adb');
    process.exit(1);
  }
  return res;
}

/* ---------- устройства ---------- */

// вывод «adb devices -l» → [{ serial, state, model }]
function parseDevices(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('List of devices'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      const model = (line.match(/model:(\S+)/) || [])[1] || '';
      return { serial, state: state || '?', model };
    });
}

async function listDevices() {
  const res = await adb(['devices', '-l']);
  return res.code === 0 ? parseDevices(res.out) : [];
}

function hint(firstRun) {
  if (firstRun) {
    console.log('Что проверить:');
    console.log('  — кабель должен быть с передачей данных (не чисто зарядный);');
    console.log('  — Настройки → Сведения о телефоне → «Номер сборки» (или «Версия MIUI»)');
    console.log('    нажать 7 раз → Для разработчиков → включить «Отладка по USB»;');
    console.log('  — на телефоне принять RSA-запрос «Разрешить отладку по USB».');
  }
}

// Ждёт пригодное устройство; SERIAL_ARG задаёт конкретное, иначе — единственное.
async function pickDevice() {
  let firstRun = true;
  while (true) {
    const devices = await listDevices();
    if (SERIAL_ARG) {
      const mine = devices.find((d) => d.serial === SERIAL_ARG);
      if (mine && mine.state === 'device') return mine;
      if (mine) console.log(`[${SERIAL_ARG}] ${mine.state} — жду состояние device…`);
      else { console.log(`[${SERIAL_ARG}] не виден — жду подключения…`); hint(firstRun); }
    } else if (devices.length === 0) {
      console.log('Телефон не виден.');
      hint(firstRun);
    } else {
      const ok = devices.filter((d) => d.state === 'device');
      if (ok.length === 1) return ok[0];
      if (ok.length > 1) {
        console.error('К adb подключено несколько устройств:');
        devices.forEach((d) => console.error(`  ${d.model || '?'}  ${d.serial}  (${d.state})`));
        console.error('Укажите одно:  node phone.mjs --serial <serial>');
        process.exit(1);
      }
      const unauthorized = devices.find((d) => d.state === 'unauthorized');
      const noperm = devices.find((d) => d.state.startsWith('no permissions'));
      if (unauthorized) {
        console.log('Телефон просит подтверждение: на его экране примите «Разрешить отладку по USB»…');
      } else if (noperm) {
        console.log('Нет прав к USB-устройству. Поставьте udev-правила:');
        console.log('  sudo apt install android-sdk-platform-tools-common');
        console.log('(и переподключите кабель). Жду…');
      } else {
        console.log('Состояния: ' + devices.map((d) => `${d.serial}: ${d.state}`).join(', ') + ' — жду…');
      }
    }
    firstRun = false;
    await sleep(2000);
  }
}

/* ---------- сервер ---------- */

let serverChild = null;

async function serverUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/index.html`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch { return false; }
}

async function ensureServer() {
  if (await serverUp()) {
    console.log(`Сервер уже поднят: http://localhost:${PORT}`);
    return;
  }
  serverChild = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], { stdio: 'inherit' });
  serverChild.on('exit', (code) => {
    if (finishing) return;
    console.error(`serve.mjs остановился (код ${code}) — выхожу.`);
    process.exitCode = 1;
    cleanupAndExit();
  });
  for (let i = 0; i < 50; i++) {
    if (await serverUp()) {
      console.log(`Сервер поднят: http://localhost:${PORT}`);
      return;
    }
    await sleep(100);
  }
  throw new Error('serve.mjs не поднялся за 5 с');
}

/* ---------- проброс порта ---------- */

// «error: closed» / «error: device offline» сразу после разблокировки телефона —
// норма: adbd ещё поднимается. Пробуем несколько раз.
async function setupReverse(serial) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await adb(['-s', serial, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`], { timeoutMs: 8000 });
    if (res.code === 0) {
      const list = await adb(['-s', serial, 'reverse', '--list']);
      if (list.code === 0 && list.out.includes(`tcp:${PORT}`)) return true;
    }
    const msg = ((res.err || res.out || '').trim().split('\n')[0]) || 'не подтвердился';
    console.log(`  проброс (попытка ${attempt}/6): ${msg} — повторю…`);
    await sleep(1500);
  }
  return false;
}

/* ---------- открытие Chrome на телефоне ---------- */

async function openInChrome(serial) {
  if (NO_OPEN) {
    console.log(`Откройте на телефоне Chrome: http://localhost:${PORT}`);
    return;
  }
  const url = `http://localhost:${PORT}`;
  let res = await adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url]);
  if (res.code !== 0 || /error|exception/i.test(res.out + res.err)) {
    // страховка: явный Chrome (на MIUI VIEW-intent может открыть свой браузер)
    res = await adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url,
      '-n', 'com.android.chrome/com.google.android.apps.chrome.IntentDispatcher']);
  }
  console.log(res.code === 0 ? `На телефоне открыт ${url}` : `Не удалось открыть — зайдите вручную: ${url}`);
}

/* ---------- слежение за USB (adb track-devices) ---------- */

const STATES = /^(device|offline|bootloader|host|recovery|unauthorized|authorizing|connecting|no permissions|sideload)/;

// Строка «serial\tstate». Часть сборок adb (в т.ч. Debian) печатает перед
// полезной строкой hex-префикс длины: «0015F6PFX…\tdevice» — переживаем оба формата.
function parseTrackerLine(raw) {
  const line = raw.replace(/\r/g, '');
  if (!line.trim()) return null; // пустая строка — разделитель снимков
  let [serial, state] = line.split('\t');
  if (!STATES.test(state || '')) {
    const m = line.match(/^[0-9a-f]{4}(.*)$/);
    if (m) {
      const [s2, st2] = m[1].split('\t');
      if (STATES.test(st2 || '')) { serial = s2; state = st2; }
    }
  }
  if (!serial || !state) return null;
  return { serial: serial.trim(), state: state.trim() };
}

let tracker = null;

function startTracker(onSnapshot) {
  tracker = spawn('adb', ['track-devices']);
  let buffer = '';
  let current = [];
  tracker.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const d = parseTrackerLine(raw);
      if (d) current.push(d);
      else if (!raw.trim() && current.length) { onSnapshot(current); current = []; }
    }
  });
  tracker.on('error', () => { /* adb пропал — restart ниже не имеет смысла */ });
  tracker.on('exit', () => {
    if (finishing) return;
    // adb-сервер умер или перезапущен — поднимем трекер снова
    setTimeout(() => { if (!finishing) startTracker(onSnapshot); }, 2000);
  });
}

function watchUsb(serial) {
  let wasOnline = true;
  let timer = null;
  startTracker((devices) => {
    const mine = devices.find((d) => d.serial === serial);
    const online = !!mine && mine.state === 'device';
    if (online && !wasOnline) {
      // adbd после переподключения поднимается не мгновенно — debounce
      clearTimeout(timer);
      timer = setTimeout(async () => {
        console.log('USB переподключён — восстанавливаю проброс…');
        if (await setupReverse(serial)) console.log(`Проброс восстановлен: http://localhost:${PORT} на телефоне снова жив.`);
      }, 700);
    } else if (!online && wasOnline) {
      console.log('Телефон отключился — жду повторного подключения (проброс восстановлю сам)…');
    }
    wasOnline = online;
  });
}

/* ---------- аккуратное завершение ---------- */

let finishing = false;
let cleaned = false;
let activeSerial = null;
let interrupted = false;

async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  finishing = true;
  if (tracker) { try { tracker.kill(); } catch { /* уже мёртв */ } }
  if (activeSerial) {
    await Promise.race([
      adb(['-s', activeSerial, 'reverse', '--remove', `tcp:${PORT}`], { timeoutMs: 3000 }),
      sleep(2000),
    ]);
  }
  if (serverChild) {
    const child = serverChild;
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* уже мёртв */ } }, 1000);
    serverChild = null;
  }
}

async function cleanupAndExit() {
  await cleanup();
  process.exit(0);
}

process.on('SIGINT', async () => {
  if (interrupted) process.exit(130); // второй Ctrl+C — немедленно
  interrupted = true;
  console.log('\nОстанавливаюсь: убираю проброс и глушу сервер…');
  await cleanupAndExit();
});
process.on('SIGTERM', cleanupAndExit);

/* ---------- сценарий ---------- */

console.log('Ищу телефон (adb)…');
const device = await pickDevice();
activeSerial = device.serial;
console.log(`Телефон: ${device.model || device.serial}  [${device.serial}]`);

await ensureServer();

console.log('Пробрасываю порт…');
if (!(await setupReverse(activeSerial))) {
  console.error('Не удалось установить adb reverse. Переподключите кабель и запустите снова.');
  await cleanup();
  process.exit(1);
}
console.log(`Готово: на телефоне работает http://localhost:${PORT} (защищённый контекст — Web MIDI и установка приложения).`);

await openInChrome(activeSerial);

console.log('');
console.log('Дальше:');
console.log('  1. на телефоне при запросе разрешите доступ к MIDI-устройствам;');
console.log('  2. дождитесь полной загрузки и нажмите «Установить приложение»');
console.log('     (или в Chrome ⋮ → «Установить приложение»);');
console.log('  3. после установки перекиньте кабель на пианино (USB-OTG) — приложение');
console.log('     работает офлайн, компьютер больше не нужен.');
console.log('');
console.log(`Этот процесс держит проброс живым и восстановит его при переподключении USB. Ctrl+C — остановить.`);

watchUsb(activeSerial);
// страховка: открытый pipe трекера и так держит event loop живым
setInterval(() => {}, 1 << 30);
