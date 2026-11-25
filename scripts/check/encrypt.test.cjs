// Запуск: node --test scripts/check/encrypt.test.cjs. Временная копия CLI, вымышленные данные и случайный код на тест.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

function sample() {
  return {
    REAL_DATA: { catalog: [{ sku: 'test-1', name: 'Образец' }], meta: { marker: 'до' } },
    BAKED_AT: '2001-01-01', BAKED_PERIOD: 'тестовый период', BAKED_FINANCE_ROWS: 1, BAKED_ADS_ROWS: 1,
    BAKED_FINANCE: [{ value: 10 }], BAKED_ADS: [{ value: 2 }],
    BAKED_FUNNEL: [], BAKED_FUNNEL_ROWS: 0, MODELED_FINANCE: [],
  };
}

// Независимый изготовитель входного контейнера. Рабочий снимок никогда не копируется в тесты.
function seal(data, code, gzip) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iter = 2000;
  const bytes = Buffer.from(JSON.stringify(data));
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.pbkdf2Sync(code, salt, iter, 32, 'sha256'), iv);
  const ct = Buffer.concat([cipher.update(gzip ? zlib.gzipSync(bytes) : bytes), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', hash: 'SHA-256', iter, ...(gzip ? { zip: 'gzip' } : {}),
    salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), period: data.BAKED_PERIOD,
  };
}

function fixture(t, gzip = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-encrypt-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts'), plain = path.join(root, 'decrypted');
  fs.mkdirSync(scripts);
  fs.mkdirSync(plain);
  for (const name of ['encrypt.cjs', 'decrypt.cjs', 'data-audit.cjs']) {
    fs.copyFileSync(path.join(__dirname, '..', name), path.join(scripts, name));
  }
  const code = crypto.randomBytes(18).toString('hex');
  const snapshot = path.join(root, 'wb-secure.js'), manifest = path.join(root, 'data-version.json');
  const pending = path.join(root, '.encrypt-pending');
  const version = { v: '200101010000', period: 'тестовый период', builtAt: '2001-01-01',
    build: 'test-build', stampedAt: 'test-stamp', extra: { keep: true } };
  fs.writeFileSync(manifest, JSON.stringify(version, null, 2) + '\n');
  const old = sample();
  if (!gzip) { delete old.BAKED_FUNNEL; delete old.MODELED_FINANCE; delete old.BAKED_FUNNEL_ROWS; }
  const envelope = seal(old, code, gzip);
  function writeEnvelope() { fs.writeFileSync(snapshot, 'const WB_SECURE = ' + JSON.stringify(envelope) + ';\n'); }
  writeEnvelope();

  const candidate = sample();
  candidate.REAL_DATA.meta.marker = 'после';
  function writeCandidate() {
    const { REAL_DATA, ...reports } = candidate;
    fs.writeFileSync(path.join(plain, 'wb-data.js'), 'const REAL_DATA = ' + JSON.stringify(REAL_DATA) + ';');
    fs.writeFileSync(path.join(plain, 'wb-reports.js'), Object.entries(reports)
      .map(([name, value]) => 'const ' + name + ' = ' + JSON.stringify(value) + ';').join('\n'));
  }
  writeCandidate();
  function run({ args = [code], fault, script = 'encrypt.cjs' } = {}) {
    const options = [];
    if (fault) {
      // Подменяем операцию только в дочернем тестовом процессе. У рабочего CLI нет тестовых флагов.
      const preload = path.join(root, 'test-fault.cjs');
      fs.writeFileSync(preload, '({' + fault.toString() + '}).fault(require("node:fs"), require("node:path"));');
      options.push('--require', preload);
    }
    const result = spawnSync(process.execPath, [...options, path.join(scripts, script), ...args], {
      cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000,
    });
    assert.ifError(result.error);
    return result;
  }
  return { root, plain, code, snapshot, manifest, pending, version, envelope, candidate, writeEnvelope, writeCandidate, run };
}

function fileBytes(file) {
  try { return fs.readFileSync(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function originalPair(f) { return [fileBytes(f.snapshot), fileBytes(f.manifest)]; }

function rejected(f, options, message, exit = 1) {
  const before = originalPair(f), pendingBefore = fs.existsSync(f.pending);
  const result = f.run(options);
  assert.equal(result.status, exit, result.stderr);
  assert.match(result.stderr, message);
  assert.deepEqual(originalPair(f), before, 'оба исходных файла или их отсутствие должны сохраниться');
  assert.equal(fs.existsSync(f.pending), pendingBefore, 'рабочий каталог очищен, чужая блокировка сохранена');
}

function successful(f, args = [f.code]) {
  const before = originalPair(f);
  const result = f.run({ args });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /roundtrip OK/);
  assert.match(result.stdout, /АУДИТ ПОЛНОТЫ ДАННЫХ:/);
  assert.notDeepEqual(fileBytes(f.snapshot), before[0]);
  const saved = JSON.parse(fileBytes(f.manifest));
  assert.deepEqual(saved, { ...f.version, v: saved.v, builtAt: saved.builtAt, period: f.candidate.BAKED_PERIOD });
  assert.match(saved.v, /^\d{12}$/);
  assert.notEqual(saved.v, f.version.v);
  assert.equal(saved.v, saved.builtAt.replace(/[-:T]/g, '').slice(0, 12));
  // Читаем штатным совместимым decrypt.cjs из временной копии и сравниваем каждое поле.
  const readback = f.run({ script: 'decrypt.cjs' });
  assert.equal(readback.status, 0, readback.stderr);
  const data = ['wb-data.js', 'wb-reports.js'].map(name => fs.readFileSync(path.join(f.plain, name), 'utf8')).join('\n');
  const actual = vm.runInNewContext(data + '\nJSON.stringify({' + Object.keys(f.candidate).join(',') + '})');
  assert.deepEqual(JSON.parse(actual), f.candidate);
  assert.equal(fs.existsSync(f.pending), false);
}

test('обычное обновление и чтение штатным дешифратором', t => successful(fixture(t)));
test('прежний формат без gzip и без необязательных массивов', t => successful(fixture(t, false)));

function damageTag(f) {
  const ct = Buffer.from(f.envelope.ct, 'base64');
  ct[ct.length - 1] ^= 1;
  f.envelope.ct = ct.toString('base64');
  f.writeEnvelope();
}

for (const allowDrop of [false, true]) {
  const flags = allowDrop ? ['--allow-drop'] : [];
  const suffix = allowDrop ? ' с --allow-drop' : '';
  test('неверный код' + suffix, t => {
    const f = fixture(t);
    rejected(f, { args: ['synthetic-wrong', ...flags] }, /проверить прежний/);
  });
  test('повреждён тег GCM' + suffix, t => {
    const f = fixture(t);
    damageTag(f);
    rejected(f, { args: [f.code, ...flags] }, /проверить прежний/);
  });
  test('отсутствует прежний снимок при наличии манифеста' + suffix, t => {
    const f = fixture(t);
    fs.unlinkSync(f.snapshot);
    rejected(f, { args: [f.code, ...flags] }, /проверить прежний/);
  });
}

test('повреждён JS-контейнер', t => {
  const f = fixture(t);
  fs.writeFileSync(f.snapshot, 'const WB_SECURE = {');
  rejected(f, {}, /проверить прежний/);
});
test('аутентифицированный JSON прежнего снимка без каталога, даже с --allow-drop', t => {
  const f = fixture(t);
  Object.assign(f.envelope, seal({ BAKED_PERIOD: 'тестовый период' }, f.code, true));
  f.writeEnvelope();
  rejected(f, { args: [f.code, '--allow-drop'] }, /проверить прежний/);
});
test('неполные подготовленные данные, даже с --allow-drop', t => {
  const f = fixture(t);
  f.candidate.BAKED_FINANCE = null;
  f.writeCandidate();
  rejected(f, { args: [f.code, '--allow-drop'] }, /обязательные данные/);
});

for (const loss of ['ключ', 'строки']) {
  test('сокращение (' + loss + ') требует --allow-drop, затем проходит с верным кодом', t => {
    const f = fixture(t);
    if (loss === 'ключ') delete f.candidate.REAL_DATA.meta;
    else { f.candidate.BAKED_ADS = []; f.candidate.BAKED_ADS_ROWS = 0; }
    f.writeCandidate();
    rejected(f, {}, loss === 'ключ' ? /пропало поле REAL_DATA.meta/ : /отчёты рекламы ВБ/, 2);
    successful(f, [f.code, '--allow-drop']);
  });
}

test('повреждён прежний манифест', t => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, '{');
  rejected(f, {}, /прочитать прежний data-version/);
});
test('отсутствует прежний манифест', t => {
  const f = fixture(t);
  fs.unlinkSync(f.manifest);
  rejected(f, {}, /прочитать прежний data-version/);
});
test('подмена временного снимка другим валидным снимком с теми же счётчиками', t => {
  const f = fixture(t);
  rejected(f, { fault(fs, path) {
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      write(file, ...args);
      if (path.basename(file) === 'next.js') fs.copyFileSync('wb-secure.js', file);
    };
  } }, /Самопроверка нового снимка/);
});
test('повреждение временного манифеста', t => {
  const f = fixture(t);
  rejected(f, { fault(fs, path) {
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, data, options) => write(file, path.basename(file) === 'next.json' ? '{}' : data, options);
  } }, /Самопроверка манифеста/);
});
test('частичная запись временного снимка с ошибкой', t => {
  const f = fixture(t);
  rejected(f, { fault(fs, path) {
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (path.basename(file) !== 'next.js') return write(file, ...args);
      write(file, 'partial');
      throw new Error('test: disk full');
    };
  } }, /test: disk full/);
});
test('невозможно сохранить резервную пару', t => {
  const f = fixture(t);
  rejected(f, { fault(fs, path) {
    const link = fs.linkSync;
    fs.linkSync = (src, dst) => {
      if (path.basename(dst) === 'previous.json') throw new Error('test: backup failed');
      link(src, dst);
    };
  } }, /test: backup failed/);
});
test('отказ переименования снимка', t => {
  const f = fixture(t);
  rejected(f, { fault(fs, path) {
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (path.basename(src) === 'next.js') throw new Error('test: snapshot rename failed');
      rename(src, dst);
    };
  } }, /test: snapshot rename failed/);
});
test('отказ переименования манифеста после замены снимка, откат и повтор', t => {
  const f = fixture(t);
  rejected(f, { fault(fs, path) {
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (path.basename(src) === 'next.json') {
        const old = fs.readFileSync('.encrypt-pending/previous.js');
        if (old.equals(fs.readFileSync('wb-secure.js'))) throw new Error('слишком рано для проверки отката');
        throw new Error('test: manifest rename failed');
      }
      rename(src, dst);
    };
  } }, /test: manifest rename failed/);
  successful(f);
});
test('другой запуск уже владеет каталогом записи', t => {
  const f = fixture(t);
  fs.mkdirSync(f.pending);
  const marker = path.join(f.pending, 'owner');
  fs.writeFileSync(marker, 'first');
  rejected(f, { args: [f.code, '--allow-drop'] }, /незавершённая запись/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'first');
});

test('ошибка чтения прежнего снимка с --allow-drop', t => {
  const f = fixture(t);
  rejected(f, { args: [f.code, '--allow-drop'], fault(fs, path) {
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => {
      if (path.basename(file) === 'wb-secure.js') throw new Error('test: read failed');
      return read(file, ...args);
    };
  } }, /проверить прежний/);
});

// При прерывании между rename новый снимок уже на месте. Сверяем оба подлинника в резерве,
// отказ повторного запуска и восстановление исходной пары из резерва при остановленных писателях.
function checkRecovery(f, before) {
  const oldSnapshot = path.join(f.pending, 'previous.js'), oldManifest = path.join(f.pending, 'previous.json');
  assert.deepEqual([fileBytes(oldSnapshot), fileBytes(oldManifest)], before);
  assert.notDeepEqual(fileBytes(f.snapshot), before[0]);
  assert.deepEqual(fileBytes(f.manifest), before[1]);
  rejected(f, {}, /незавершённая запись/);
  fs.renameSync(oldSnapshot, f.snapshot);
  fs.rmSync(f.pending, { recursive: true });
  assert.deepEqual(originalPair(f), before);
}

test('принудительная остановка между переименованиями: сохранена и восстанавливается исходная пара', t => {
  const f = fixture(t), before = originalPair(f);
  const result = f.run({ fault(fs, path) {
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (path.basename(src) === 'next.json') {
        // Windows возвращает 1 и при обычной ошибке. Отмечаем точку остановки и отличаем штатный выход.
        process.on('exit', () => fs.writeSync(2, 'Штатный выход\n'));
        fs.writeSync(2, 'Перед заменой манифеста\n');
        process.kill(process.pid, 'SIGKILL');
      }
      rename(src, dst);
    };
  } });
  assert.equal(result.stderr.trim(), 'Перед заменой манифеста');
  if (process.platform === 'win32') {
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
  } else {
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.status, null);
  }
  checkRecovery(f, before);
});

test('отказ файловой системы при откате: резерв доступен для восстановления', t => {
  const f = fixture(t), before = originalPair(f);
  const result = f.run({ fault(fs, path) {
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (['next.json', 'previous.js'].includes(path.basename(src))) throw new Error('test: rename failed');
      rename(src, dst);
    };
  } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Откат не удался/);
  checkRecovery(f, before);
});
