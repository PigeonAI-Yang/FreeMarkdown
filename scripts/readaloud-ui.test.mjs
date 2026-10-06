import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import CDP from 'chrome-remote-interface';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

const cdpAddress = { host: '::1', port: 9223 };
const expectedOrigin = 'http://127.0.0.1:1420';
const eventBinding = '__fmReadAloudUiSignal';
const timeoutMs = Number(process.env.FREEMARKDOWN_READALOUD_TIMEOUT_MS ?? 60000);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 15000 && timeoutMs <= 180000,
  'FREEMARKDOWN_READALOUD_TIMEOUT_MS must be between 15000 and 180000');

let client;
let targetUrl;
let fixtureRoot;
let fixtureNumber = 0;
let currentFixturePaths = [];
let originalActivePath;
let originalSettingsOpen = false;
let originalSettingsCategory;
let originalFollow;
let originalPreferencesRaw;
let originalModelDir;
let testPreferences;
const eventRows = [];
const eventWaiters = new Set();

function uiSnapshot() {
  const start = document.querySelector('[data-readaloud="start"]');
  const current = document.querySelector('.readaloud-current');
  const status = document.querySelector('.readaloud-status');
  const app = window.__fm?.appStore.get();
  return {
    startText: start?.textContent?.trim() ?? null,
    startTitle: start?.title ?? null,
    stopVisible: Boolean(document.querySelector('[data-readaloud="stop"]')),
    statusText: status?.textContent?.trim() ?? null,
    statusTitle: status?.title ?? null,
    highlight: current ? {
      text: current.textContent?.trim() ?? '',
      sourcepos: current.getAttribute('data-sourcepos'),
    } : null,
    activePath: app?.activePanelPath ?? null,
    settingsOpen: app?.settingsOpen ?? false,
    settingsCategory: Array.from(document.querySelectorAll('nav button'))
      .find(button => button.classList.contains('bg-accent-soft'))?.textContent?.trim() ?? null,
    toolbarOptionsCount: document.querySelectorAll('[data-readaloud="options"], .readaloud-options').length,
    directStart: (() => {
      const button = document.querySelector('[data-readaloud="from-here"]');
      return button ? {
        text: button.textContent?.trim() ?? '',
        title: button.getAttribute('title'),
        disabled: button.disabled,
      } : null;
    })(),
    readAloudCardVisible: Array.from(document.querySelectorAll('section'))
      .some(section => section.querySelector('h2')?.textContent?.trim() === '朗读'),
    speedValue: document.querySelector('[data-setting="readaloud-speed"]')?.value ?? null,
    followChecked: document.querySelector('[data-setting="readaloud-follow"] [role="switch"]')
      ?.getAttribute('aria-checked') ?? null,
    modelPath: document.querySelector('[data-setting="readaloud-model-path"]')?.getAttribute('title') ?? null,
    voiceText: Array.from(document.querySelectorAll('[data-setting="readaloud-voice"]'))
      .map(element => element.textContent?.trim()).join('') || null,
    modelFolderButton: Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === '选择本地模型文件夹')?.textContent?.trim() ?? null,
    docPaths: Array.from(document.querySelectorAll('.doc-scroll[data-reading-path]'))
      .map(node => node.getAttribute('data-reading-path')),
  };
}

async function evaluate(expression) {
  const response = await client.Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed');
  }
  return response.result.value;
}

function callPage(fn, ...args) {
  return evaluate(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`);
}

async function readUi() {
  return callPage(uiSnapshot);
}

async function waitForUi(predicate, description, args = [], timeout = timeoutMs) {
  const expression = `new Promise((resolve, reject) => {
    const predicate = (${predicate.toString()});
    const args = ${JSON.stringify(args)};
    let settled = false;
    let lastState = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      clearInterval(propertyTimer);
      fn(value);
    };
    const inspect = () => {
      const state = (${uiSnapshot.toString()})();
      lastState = state;
      if (predicate(state, ...args)) finish(resolve, state);
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const propertyTimer = setInterval(inspect, 50);
    const timer = setTimeout(() => finish(reject, new Error(
      ${JSON.stringify(`Timed out waiting for ${description}; last UI state: `)} + JSON.stringify(lastState),
    )), ${timeout});
    inspect();
  })`;
  return evaluate(expression);
}

function clickControl(selector) {
  const control = document.querySelector(selector);
  if (!(control instanceof HTMLElement)) throw new Error(`Missing UI control: ${selector}`);
  if ('disabled' in control && control.disabled) throw new Error(`Disabled UI control: ${selector}`);
  control.click();
  return { text: control.textContent?.trim() ?? '', title: control.getAttribute('title') };
}

function clickSettingsCategory(label) {
  const button = Array.from(document.querySelectorAll('nav button'))
    .find(candidate => candidate.textContent?.trim() === label);
  if (!(button instanceof HTMLElement)) throw new Error(`Missing settings category: ${label}`);
  button.click();
  return button.textContent?.trim() ?? '';
}

function setVisibleSpeed(value) {
  const control = document.querySelector('[data-setting="readaloud-speed"]');
  if (!(control instanceof HTMLSelectElement)) throw new Error('Missing read-aloud speed selector');
  if (!Array.from(control.options).some(option => option.value === value)) {
    throw new Error(`Speed option is unavailable: ${value}`);
  }
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Cannot set read-aloud speed through the native select control');
  setValue.call(control, value);
  control.dispatchEvent(new Event('change', { bubbles: true }));
  return control.value;
}

function settleEventWaiter(waiter, error, row) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  eventWaiters.delete(waiter);
  if (error) waiter.reject(error);
  else waiter.resolve(row);
}

function waitForEvent(predicate, description, afterIndex = 0, timeout = timeoutMs) {
  const existing = eventRows.find((row, index) => index >= afterIndex && predicate(row));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveEvent, rejectEvent) => {
    const waiter = {
      afterIndex,
      predicate,
      resolve: resolveEvent,
      reject: rejectEvent,
      settled: false,
      timer: setTimeout(() => settleEventWaiter(
        waiter,
        new Error(`Timed out waiting for ${description}; received ${eventRows.length} read-aloud events`),
      ), timeout),
    };
    eventWaiters.add(waiter);
  });
}

function waitForNativeEvent(predicate, description, afterIndex = 0) {
  return waitForEvent(row => row.source === 'native' && predicate(row.payload), description, afterIndex);
}

function recordBindingEvent({ name, payload }) {
  if (name !== eventBinding) return;
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return;
  }
  const row = { source: data.testSource ? 'test' : 'native', payload: data };
  const index = eventRows.push(row) - 1;
  for (const waiter of eventWaiters) {
    if (index >= waiter.afterIndex && waiter.predicate(row)) settleEventWaiter(waiter, null, row);
  }
}

function markdownFor(id, longFirst = false) {
  const first = [
    `第一段 fixture ${id} 用于验证 FreeMarkdown 真实朗读界面的播放位置。`,
    '开始播放后，界面应等待本机语音服务发出正在播放事件，再高亮对应的原文段落。',
    '这段较长的测试正文也让暂停、继续和切换段落拥有稳定的可观察位置。',
    '自动化只检查按钮状态、原文位置和事件顺序，不判断语音听起来是否自然。',
    '暂停时当前位置应继续留在原文中，继续播放后仍可使用上一段和下一段按钮。',
  ].join('');
  const second = [
    `第二段 fixture ${id} 用于检查下一段和上一段按钮是否移动原文高亮。`,
    '第二个段落使用独立的 Markdown 来源位置，切换后不能只更新工具栏文字。',
    '如果打开新标签，朗读状态仍应指向开始播放的文档，而不是新焦点文档。',
    '测试夹具只写入独立临时目录，结束时会关闭这些文档并删除该目录。',
  ].join('');
  return `${longFirst ? first.repeat(10) : first}\n\n${second}\n${longFirst ? `\n${second}\n`.repeat(10) : ""}`;
}

async function setServicePreferences(preferences) {
  return callPage(async value => {
    const { setReadingPreference } = await import('/src/readaloud/service.ts');
    await setReadingPreference(value);
    return true;
  }, preferences);
}

async function openFixture(path) {
  await callPage(value => window.__fm.openFile(value), path);
  return waitForUi(
    (state, expected) => state.activePath === expected && state.docPaths.includes(expected),
    `fixture ${basename(path)} to become the active document`,
    [path],
  );
}

async function clickAndWaitForPlaying(path, description = 'native playing event') {
  const afterIndex = eventRows.length;
  await callPage(clickControl, '[data-readaloud="start"]');
  const event = await waitForNativeEvent(
    payload => payload.kind === 'playing' && payload.unit?.line === 1,
    description,
    afterIndex,
  );
  await waitForUi(
    state => state.highlight?.sourcepos?.startsWith('1:'),
    `source line 1 highlight for ${basename(path)}`,
  );
  return event.payload;
}

async function returnToReadingIfNeeded() {
  let state = await readUi();
  if (state.settingsOpen) {
    await callPage(clickControl, 'button[title="返回阅读"]');
    state = await waitForUi(current => !current.settingsOpen, 'settings page to close');
  }
  return state;
}

async function openReadAloudSettings() {
  await callPage(clickControl, 'button[title="设置"]');
  await waitForUi(state => state.settingsOpen, 'settings page to open');
  await callPage(clickSettingsCategory, '阅读');
  return waitForUi(state => state.readAloudCardVisible, 'read-aloud settings card to appear');
}

async function stopFromUiIfNeeded() {
  let state = await returnToReadingIfNeeded();
  if (state.stopVisible) {
    await callPage(clickControl, '[data-readaloud="stop"]');
    state = await waitForUi(
      current => !current.stopVisible && !current.highlight,
      'stop control and paragraph highlight to clear',
    );
  }
}

async function closeCurrentFixtures() {
  if (!currentFixturePaths.length) return;
  await returnToReadingIfNeeded();
  await callPage(paths => {
    const dock = window.__fm?.dock;
    for (const path of paths) {
      const panel = dock?.getPanel(`doc:${path}`);
      if (panel) dock.removePanel(panel);
    }
    return true;
  }, currentFixturePaths);
  currentFixturePaths = [];
}

describe('FreeMarkdown read-aloud UI integration', { concurrency: false, timeout: timeoutMs * 4 + 30000 }, () => {
  before(async () => {
    const targets = await CDP.List(cdpAddress);
    const target = targets.find(item => {
      if (item.type !== 'page') return false;
      try {
        const url = new URL(item.url);
        return url.origin === expectedOrigin && url.pathname === '/' && !url.search && !url.hash;
      } catch {
        return false;
      }
    });
    assert.ok(target, `Expected the FreeMarkdown task page at ${expectedOrigin}/ on [::1]:9223`);
    targetUrl = target.url;
    client = await CDP({ ...cdpAddress, target: target.id });
    client.Runtime.bindingCalled(recordBindingEvent);
    await client.Runtime.enable();
    await client.Runtime.addBinding({ name: eventBinding });
    assert.match(await evaluate('document.title'), /FreeMarkdown/, 'CDP target title belongs to FreeMarkdown');
    assert.equal(await evaluate('Boolean(window.__fm?.appStore && window.__fm?.dock)'), true,
      'target is the isolated FreeMarkdown development app');
    await evaluate(`(async () => {
      const { listen } = await import('/node_modules/.vite/deps/@tauri-apps_api_event.js');
      window.__fmReadAloudUiEvents = [];
      window.__fmReadAloudUiUnlisten = await listen('readaloud:event', event => {
        const payload = { ...event.payload };
        window.__fmReadAloudUiEvents.push(payload);
        window.${eventBinding}(JSON.stringify(payload));
      });
      return true;
    })()`);

    const initial = await readUi();
    originalActivePath = initial.activePath;
    originalSettingsOpen = initial.settingsOpen;
    originalSettingsCategory = initial.settingsCategory;
    originalPreferencesRaw = await evaluate("localStorage.getItem('readaloud-preferences')");
    const original = originalPreferencesRaw ? JSON.parse(originalPreferencesRaw) : {};
    originalModelDir = typeof original.modelDir === 'string' ? original.modelDir : '';
    const configuredModelDir = process.env.FREEMARKDOWN_TTS_MODEL_DIR?.trim() || originalModelDir;
    assert.ok(configuredModelDir, 'set FREEMARKDOWN_TTS_MODEL_DIR or configure a model in this dev profile');
    const modelDir = resolve(configuredModelDir);
    for (const file of ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt', 'lexicon.txt', 'vocos_24khz.onnx', 'conversation-female.wav']) {
      await stat(join(modelDir, file));
    }
    testPreferences = { modelDir, voice: 0, speed: 1 };
    fixtureRoot = await mkdtemp(join(tmpdir(), 'freemarkdown-readaloud-ui-'));

    if (!initial.settingsOpen) {
      await callPage(clickControl, 'button[title="设置"]');
      await waitForUi(state => state.settingsOpen, 'settings page for original follow state');
    }
    if (initial.settingsCategory !== '阅读') {
      await callPage(clickSettingsCategory, '阅读');
      await waitForUi(state => state.settingsCategory === '阅读', 'reading settings category');
    }
    const initialReadingSettings = await readUi();
    originalFollow = initialReadingSettings.followChecked === null
      ? undefined
      : initialReadingSettings.followChecked === 'true';
    if (!originalSettingsOpen) await returnToReadingIfNeeded();
    else if (originalSettingsCategory) {
      await callPage(clickSettingsCategory, originalSettingsCategory);
      await waitForUi(state => state.settingsCategory === originalSettingsCategory,
        'original settings category to return');
    }

    await returnToReadingIfNeeded();
    await stopFromUiIfNeeded();
    await setServicePreferences(testPreferences);
    await waitForUi(state => !state.stopVisible && !state.highlight, 'idle playback before UI tests');
  });

  beforeEach(async (context) => {
    await returnToReadingIfNeeded();
    await stopFromUiIfNeeded();
    await setServicePreferences(testPreferences);
    fixtureNumber += 1;
    const fixtureId = `ui-${fixtureNumber}`;
    const path = join(fixtureRoot, `${fixtureId}.md`);
    await writeFile(path, markdownFor(fixtureId, context.name.startsWith('does not start automatically')), 'utf8');
    currentFixturePaths = [path];
    await openFixture(path);
  });

  afterEach(async () => {
    if (!client || !fixtureRoot) return;
    await stopFromUiIfNeeded();
    await closeCurrentFixtures();
    if (originalActivePath) {
      await callPage(path => window.__fm.openFile(path), originalActivePath);
      await waitForUi((state, path) => state.activePath === path, 'original document to regain focus',
        [originalActivePath]);
    }
  });

  after(async () => {
    if (client) {
      try {
        await stopFromUiIfNeeded();
        await closeCurrentFixtures();
        if (originalActivePath) await callPage(path => window.__fm.openFile(path), originalActivePath);
        const original = originalPreferencesRaw ? JSON.parse(originalPreferencesRaw) : {};
        await setServicePreferences({
          modelDir: originalModelDir,
          voice: 0,
          speed: Number.isFinite(original.speed) && original.speed >= 0.6 && original.speed <= 1.6
            ? original.speed
            : 1,
        });
        await callPage(raw => {
          if (raw === null) localStorage.removeItem('readaloud-preferences');
          else localStorage.setItem('readaloud-preferences', raw);
          return true;
        }, originalPreferencesRaw);
        if (originalFollow !== undefined) {
          await callPage(async value => {
            const { setFollow } = await import('/src/readaloud/service.ts');
            setFollow(value);
            return true;
          }, originalFollow);
        }
        if (originalSettingsOpen) {
          const state = await readUi();
          if (!state.settingsOpen) {
            await callPage(clickControl, 'button[title="设置"]');
            await waitForUi(current => current.settingsOpen, 'original settings page to reopen');
          }
          if (originalSettingsCategory) {
            await callPage(clickSettingsCategory, originalSettingsCategory);
            await waitForUi(current => current.settingsCategory === originalSettingsCategory,
              'original settings category to restore');
          }
        } else {
          await returnToReadingIfNeeded();
        }
        await callPage(async () => {
          await window.__fmReadAloudUiUnlisten?.();
          return true;
        });
      } finally {
        console.log(`READALOUD_UI_TARGET ${targetUrl}`);
        console.log(`READALOUD_UI_NATIVE_TRACE ${JSON.stringify(eventRows
          .filter(row => row.source === 'native')
          .map(({ payload }) => ({ token: payload.token, kind: payload.kind,
            line: payload.unit?.line, paragraph: payload.unit?.paragraph, id: payload.unit?.id })))}`);
        await client.close();
      }
    }
    if (fixtureRoot) {
      const resolvedFixtureRoot = resolve(fixtureRoot);
      assert.equal(resolve(dirname(resolvedFixtureRoot)), resolve(tmpdir()),
        'temporary fixture parent must be the system temp directory');
      assert.ok(basename(resolvedFixtureRoot).startsWith('freemarkdown-readaloud-ui-'),
        'temporary fixture directory must use the read-aloud test prefix');
      await rm(resolvedFixtureRoot, { recursive: true, force: true });
    }
  });

  test('does not start automatically and starts from the real toolbar button', async () => {
    const path = currentFixturePaths[0];
    const initial = await readUi();
    assert.match(initial.startText, /朗读/);
    assert.equal(initial.statusText, null);
    assert.equal(initial.highlight, null);
    assert.equal(initial.toolbarOptionsCount, 0, 'toolbar has no read-aloud settings control or popover');
    assert.deepEqual(initial.directStart, {
      text: '从这里朗读',
      title: '从当前可见段落开始',
      disabled: false,
    });
    await openReadAloudSettings();
    const settings = await readUi();
    assert.equal(settings.voiceText, '对话女声');
    assert.deepEqual(await evaluate("Array.from(document.querySelector('[data-setting=\"readaloud-speed\"]')?.options ?? []).map(option => option.value)"),
      ['0.6', '0.8', '1', '1.2', '1.4', '1.6']);
    assert.notEqual(settings.followChecked, null);
    assert.equal(settings.modelPath, testPreferences.modelDir);
    assert.equal(settings.modelFolderButton, '选择本地模型文件夹');
    await callPage(clickControl, '[data-setting="readaloud-follow"] [role="switch"]');
    await waitForUi((state, initialFollow) => state.followChecked !== initialFollow,
      'follow-current-paragraph setting to toggle', [settings.followChecked]);
    await callPage(clickControl, '[data-setting="readaloud-follow"] [role="switch"]');
    await waitForUi((state, initialFollow) => state.followChecked === initialFollow,
      'follow-current-paragraph setting to return to its starting value', [settings.followChecked]);
    await callPage(clickControl, 'button[title="返回阅读"]');
    await waitForUi(state => !state.settingsOpen, 'settings page to close');
    await openFixture(path);

    const event = await clickAndWaitForPlaying(path, 'native playback after toolbar start');
    const state = await readUi();
    assert.match(state.startText, /暂停/);
    assert.equal(state.highlight.sourcepos.split(':')[0], String(event.unit.line));
    assert.equal(state.statusTitle, path);

    const visibleLine = await callPage(source => {
      const surface = document.querySelector(`.doc-scroll[data-reading-path="${CSS.escape(source)}"]`);
      const paragraph = surface?.querySelector('p[data-sourcepos^="3:"]');
      if (!surface || !paragraph) throw new Error('Missing second source paragraph');
      surface.scrollTo({ top: surface.scrollTop + paragraph.getBoundingClientRect().top
        - surface.getBoundingClientRect().top, behavior: 'instant' });
      const top = surface.getBoundingClientRect().top;
      const visible = Array.from(surface.querySelectorAll('[data-sourcepos]'))
        .find(element => element.getBoundingClientRect().bottom > top);
      return Number(visible?.getAttribute('data-sourcepos')?.split(':')[0]);
    }, path);
    assert.equal(visibleLine, 3, 'the second paragraph is the first visible source');
    const directStartIndex = eventRows.length;
    await callPage(clickControl, '[data-readaloud="from-here"]');
    const directStart = await waitForNativeEvent(
      payload => payload.kind === 'playing',
      'native playback after the from-visible toolbar action',
      directStartIndex,
    );
    const directState = await waitForUi(
      (current, line) => current.highlight?.sourcepos?.startsWith(`${line}:`),
      'from-visible toolbar action to highlight its native playback source',
      [directStart.payload.unit.line],
    );
    assert.equal(directState.statusTitle, path);
    assert.equal(directStart.payload.unit.line, visibleLine, 'direct start uses the visible paragraph');
  });

  test('pause and resume buttons preserve the active source position', async () => {
    const path = currentFixturePaths[0];
    const playing = await clickAndWaitForPlaying(path);
    const position = await readUi();
    await callPage(clickControl, '[data-readaloud="start"]');
    const paused = await waitForUi(state => /继续/.test(state.startText ?? ''), 'pause button state');
    assert.equal(paused.highlight.sourcepos, position.highlight.sourcepos);
    assert.equal(paused.statusTitle, path);

    await callPage(clickControl, '[data-readaloud="start"]');
    const resumed = await waitForUi(state => /暂停/.test(state.startText ?? ''), 'resume button state');
    assert.equal(resumed.statusTitle, path);
    assert.ok(resumed.highlight, `resume retains a playback position after native token ${playing.token}`);
  });

  test('previous and next controls move the actual source highlight', async () => {
    const path = currentFixturePaths[0];
    const first = await clickAndWaitForPlaying(path);
    const firstLine = String(first.unit.line);
    await callPage(clickControl, 'button[title="下一段"]');
    const second = await waitForNativeEvent(
      payload => payload.kind === 'playing' && payload.unit?.paragraph === 1,
      'native playback in the next paragraph',
      eventRows.length,
    );
    const secondState = await waitForUi(
      (state, line) => state.highlight?.sourcepos?.startsWith(`${line}:`),
      'next paragraph source highlight',
      [second.payload.unit.line],
    );
    assert.notEqual(secondState.highlight.sourcepos.split(':')[0], firstLine);

    const afterNext = eventRows.length;
    await callPage(clickControl, 'button[title="上一段"]');
    const returned = await waitForNativeEvent(
      payload => payload.kind === 'playing' && payload.unit?.paragraph === 0,
      'native playback in the previous paragraph',
      afterNext,
    );
    const firstState = await waitForUi(
      (state, line) => state.highlight?.sourcepos?.startsWith(`${line}:`),
      'previous paragraph source highlight',
      [returned.payload.unit.line],
    );
    assert.equal(firstState.highlight.sourcepos.split(':')[0], firstLine);
  });

  test('keeps the reading source when a different document tab becomes active', async () => {
    const sourcePath = currentFixturePaths[0];
    const sourceEvent = await clickAndWaitForPlaying(sourcePath);
    const otherPath = join(fixtureRoot, `ui-${fixtureNumber}-other.md`);
    await writeFile(otherPath, '# Other UI fixture\n\nThis document changes focus only.\n', 'utf8');
    currentFixturePaths.push(otherPath);
    await openFixture(otherPath);
    const afterSwitch = eventRows.length;
    await waitForNativeEvent(
      payload => payload.kind === 'playing' && payload.token === sourceEvent.token,
      'native playback continuing after another tab becomes active',
      afterSwitch,
    );
    const state = await readUi();
    assert.equal(state.activePath, otherPath);
    assert.equal(state.statusTitle, sourcePath);
    assert.equal(state.startTitle, `朗读文档：${sourcePath}`);
  });

  test('speed is changed through settings and stops active reading', async () => {
    const path = currentFixturePaths[0];
    await clickAndWaitForPlaying(path);
    await openReadAloudSettings();
    await callPage(setVisibleSpeed, '1.2');
    await waitForUi(state => state.speedValue === '1.2', 'settings speed selection and preference update');
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('readaloud-preferences')).speed"), 1.2);
    await callPage(clickSettingsCategory, '外观');
    await callPage(clickSettingsCategory, '阅读');
    assert.equal((await readUi()).speedValue, '1.2', 'speed persists when the settings pane remounts');
    await callPage(clickControl, 'button[title="返回阅读"]');
    const changed = await waitForUi(state => !state.settingsOpen && /朗读/.test(state.startText ?? '')
      && !/继续|暂停/.test(state.startText ?? '') && !state.stopVisible,
    'speed change to stop the active reading session');
    assert.equal(changed.highlight, null, 'changing speed stops the active reading session');
    assert.equal(changed.statusText, null);
  });

  test('settings pause playback and the paused source highlight returns with its tab', async () => {
    const path = currentFixturePaths[0];
    const playing = await clickAndWaitForPlaying(path);
    await callPage(clickControl, 'button[title="设置"]');
    const settings = await waitForUi(state => state.settingsOpen, 'settings page to open');
    assert.equal(settings.startText, null, 'settings replaces the toolbar while open');
    await callPage(clickSettingsCategory, '阅读');
    await waitForUi(state => state.readAloudCardVisible && state.followChecked !== null,
      'read-aloud settings shown while playback is paused');
    await callPage(clickControl, 'button[title="返回阅读"]');
    const resumedControl = await waitForUi(state => !state.settingsOpen && /继续/.test(state.startText ?? ''),
      'paused read-aloud control after returning from settings');
    assert.equal(resumedControl.statusTitle, path);
    assert.match(resumedControl.statusText, /已暂停/);
    await openFixture(path);
    const remounted = await waitForUi(
      (state, source) => !state.settingsOpen && state.activePath === source
        && state.docPaths.includes(source) && Boolean(state.highlight),
      'paused source position to highlight after reopening its tab',
      [path],
      Math.min(timeoutMs, 15000),
    );
    assert.equal(remounted.statusTitle, path);
    assert.equal(remounted.highlight.sourcepos.split(':')[0], String(playing.unit.line));
  });

  test('stop clears playback UI and a late old-token event cannot restore it', async () => {
    const path = currentFixturePaths[0];
    const playing = await clickAndWaitForPlaying(path);
    await callPage(clickControl, '[data-readaloud="stop"]');
    const stopped = await waitForUi(
      state => /朗读/.test(state.startText ?? '') && !state.stopVisible && !state.highlight,
      'stop control, status, and source highlight to clear',
    );
    assert.equal(stopped.statusText, null);

    const afterStopEventIndex = eventRows.length;
    await callPage(async payload => {
      const { emit } = await import('/node_modules/.vite/deps/@tauri-apps_api_event.js');
      await emit('readaloud:event', { ...payload, kind: 'playing', testSource: 'stale-stop-check' });
      return true;
    }, { token: playing.token, unit: playing.unit });
    await waitForEvent(row => row.source === 'test' && row.payload.testSource === 'stale-stop-check',
      'stale event delivery through the app event bus', afterStopEventIndex);
    const afterStaleEvent = await readUi();
    assert.equal(afterStaleEvent.startText, stopped.startText);
    assert.equal(afterStaleEvent.statusText, null);
    assert.equal(afterStaleEvent.highlight, null);
  });

  test('editing the source file invalidates the active reading snapshot', async () => {
    const path = currentFixturePaths[0];
    await clickAndWaitForPlaying(path);
    await appendFile(path, '\nChanged by the isolated UI test.\n', 'utf8');
    const changed = await waitForUi(
      state => /文档已更改/.test(state.statusText ?? '') && !state.stopVisible && !state.highlight,
      'source-change event to invalidate playback and clear its highlight',
    );
    assert.equal(changed.statusTitle, '文档已更改，请重新开始朗读。');
    assert.match(changed.startText, /朗读/);
  });

  test('closing the source panel stops reading and removes its highlight', async () => {
    const path = currentFixturePaths[0];
    await clickAndWaitForPlaying(path);
    await callPage(value => {
      const panel = window.__fm.dock.getPanel(`doc:${value}`);
      if (!panel) throw new Error('Fixture document panel is missing');
      window.__fm.dock.removePanel(panel);
      return true;
    }, path);
    currentFixturePaths = [];
    const closed = await waitForUi(
      (state, closedPath) => !state.docPaths.includes(closedPath) && !state.stopVisible && !state.highlight,
      'source panel removal to stop playback',
      [path],
    );
    assert.match(closed.startText, /朗读/);
    assert.equal(closed.statusText, null);
  });
});
