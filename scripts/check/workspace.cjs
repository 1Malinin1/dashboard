'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { dashboardAssets } = require('../lib/dashboard-browser.cjs');

const project = path.resolve(__dirname, '../..');

// Внутри этой копии штатные скрипты могут использовать свои относительные пути.
async function withCheckWorkspace(run, outputParent) {
  const root = await fs.realpath(project);
  const parent = await fs.realpath(outputParent || os.tmpdir());
  const relative = path.relative(root, parent);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Временный каталог проверки должен находиться вне проекта.');
  }
  const dir = await fs.mkdtemp(path.join(parent, 'dashboard-check-'));
  try {
    for (const name of [...dashboardAssets, 'scripts/decrypt.cjs', 'scripts/resupply-report.cjs']) {
      const from = path.join(root, name), to = path.join(dir, name);
      if (await fs.realpath(from) !== from) throw new Error('Ссылка вместо файла проекта: ' + name);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
    await run(dir);
    for (const name of ['wb-secure.js', 'data-version.json']) {
      const copy = await fs.readFile(path.join(dir, name));
      if (!copy.equals(await fs.readFile(path.join(root, name)))) {
        throw new Error('Исходный снимок или манифест изменился во время прогона.');
      }
    }
  } catch (error) {
    console.error('Каталог неуспешной проверки сохранён для сверки:', dir);
    throw error;
  }
  if (path.dirname(dir) !== parent || await fs.realpath(dir) !== dir) throw new Error('Изменился путь временного каталога.');
  if (outputParent) {
    // При явном OUT_DIR сохраняем только запрошенные результаты, без расшифрованного снимка.
    const results = await fs.mkdtemp(path.join(parent, 'dashboard-results-'));
    for (const file of ['fulltruck-result.json', 'script-ft.json', 'dl']) {
      await fs.cp(path.join(dir, file), path.join(results, file), { recursive: true });
    }
    console.log('Результаты проверки подсорта:', results);
  }
  await fs.rm(dir, { recursive: true, maxRetries: 3, retryDelay: 150 });
}

module.exports = { withCheckWorkspace };
