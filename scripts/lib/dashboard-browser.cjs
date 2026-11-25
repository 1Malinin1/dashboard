'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const windows = process.platform === 'win32';

async function withBrowser(run) {
  const executablePath = process.env.PW_CHROME || (windows ? undefined : '/opt/pw-browsers/chromium');
  if (windows && !executablePath) throw new Error('Для запуска Chrome задайте PW_CHROME в окружении Windows.');
  const env = { ...process.env };
  delete env.VERIFY_CODE;
  delete env.WB_CODE;
  const browser = await chromium.launch({ executablePath, chromiumSandbox: windows, env });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

// Отдаём только файлы, которые читает страница. Рабочие отчёты и decrypted/ по HTTP недоступны.
const assets = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/favicon.svg', 'image/svg+xml'],
  ['/wb-secure.js', 'text/javascript; charset=utf-8'],
  ['/data-version.json', 'application/json'],
  ['/ОПЫТ.md', 'text/plain; charset=utf-8'],
  ['/calc/ozon-fin.js', 'text/javascript; charset=utf-8'],
  ['/calc/resupply.js', 'text/javascript; charset=utf-8'],
]);

async function unlockDashboard(page, code) {
  if (!code) throw new Error('Не задан код для проверки.');
  const url = new URL(page.url());
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Для ввода кода требуется локальная страница Dashboard.');
  }
  await page.locator('#lockRemember').uncheck();
  try {
    await page.locator('#lockInput').fill(code);
  } catch {
    throw new Error('Не удалось заполнить поле кода доступа.');
  }
  await page.locator('.lock-btn').click();
  await page.locator('#lockScreen').waitFor({ state: 'hidden', timeout: 60000 });
  if (await page.evaluate(() => localStorage.getItem('wb_pass_v1') !== null)) {
    throw new Error('Код доступа сохранён в тестовом контексте.');
  }
}

async function serveAsset(directory, req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const type = assets.get(pathname);
  if (!type) return res.writeHead(404).end();
  try {
    const file = path.join(directory, pathname.slice(1));
    if (await fs.realpath(file) !== file) return res.writeHead(404).end();
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
}

async function withDashboardServer(port, run, directory = root) {
  const base = await fs.realpath(directory);
  const server = http.createServer((req, res) => serveAsset(base, req, res));
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    return await run(url);
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}

function withDashboardBrowser(port, run) {
  return withDashboardServer(port, url => withBrowser(browser => run(browser, url)));
}

module.exports = { withBrowser, withDashboardBrowser, withDashboardServer, unlockDashboard,
  dashboardAssets: [...assets.keys()].map(name => name.slice(1)) };
