// 验收探针：编辑面板保存后，同路径的卡片导出面板是否自动重跑预览管线。
//
// 前置：dev 应用带 CDP 运行（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223），vite（1420）存活。
//   node scripts/card-refresh-probe.mjs
//
// 夹具：仓库里受版本控制的 testdata/验收样例.md 只读，先拷到 testdata/out/card-refresh-check.md 再编辑。
//
// 观测口径（踩过的坑都写在这里）：
//   - 卡片面板默认是「导出模式（3:4 固定拆卡）」，整篇被切成 14 张卡，DOM 里只挂当前卡的块。
//     所以断言标记必须落在第 1 张卡覆盖的块上（本脚本把标记追加到第 1 行标题行，第 1 张卡必然包含它）。
//   - dockview 4.13 默认渲染器只在面板可见时挂载组件：卡片面板作为同分组的隐藏标签时
//     .card-root 在 DOM 里根本不存在（不是"内容没刷新"）。定位必须按「活动标签 → 所在分组 → .card-root」，
//     不能全局扫 .card-panel（同内容的其他卡片面板会串味）。
import CDP from "chrome-remote-interface";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9223);
const ROOT = "J:/PigeonYang/FreeMarkdown";
const OUT = join(ROOT, "testdata", "out");
const SRC = join(ROOT, "testdata", "验收样例.md");
const FIX = join(OUT, "card-refresh-check.md");
const BASE = "card-refresh-check.md";
const MARK = "卡片刷新验证 MARK6391";
const MARK2 = "卡片刷新验证 MARK6392";
const MARK_EXT = "外部改动 EXT8842";

mkdirSync(OUT, { recursive: true });
if (!existsSync(SRC)) {
  console.error("夹具缺失：", SRC);
  process.exit(2);
}
copyFileSync(SRC, FIX);

const P = FIX.replace(/\//g, "\\");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
let failures = 0;
function check(name, ok, detail) {
  steps.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}\n        ${detail}`);
}
const note = (t) => console.log(`[NOTE] ${t}`);
const step = (t) => console.log(`[STEP] ${t}`);

/* ---------------- CDP ---------------- */

const client = await CDP({ port, wait: true });
const { Runtime, Log } = client;
await Runtime.enable();
await Log.enable();
const consoleErrors = [];
Log.entryAdded((e) => {
  if (e.entry.level === "error") consoleErrors.push(String(e.entry.text).slice(0, 200));
});
Runtime.exceptionThrown((e) =>
  consoleErrors.push(
    String(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "").slice(0, 240),
  ),
);

async function ev(expr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval failed");
      }
      return r.result.value;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (attempt < 2 && /Execution context was destroyed|Cannot find context/i.test(msg)) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

const probe = () => `window.__fmEdit.get(${JSON.stringify(P)})`;

/* 严格定位本夹具的卡片正文根：卡片标签必须是所在分组的活动标签（否则组件被 dockview 卸载）。 */
const FIND_ROOT = `(() => {
  const tab = [...document.querySelectorAll('.dv-tab')].find(t => {
    const s = t.textContent || '';
    return s.includes('卡片') && s.includes(${JSON.stringify(BASE)});
  });
  if (!tab) return { root: null, how: '无卡片标签' };
  const active = tab.className.includes('dv-active-tab');
  const group = tab.closest('.dv-groupview');
  const root = active && group ? group.querySelector('.card-root') : null;
  return {
    root,
    how: active ? '活动标签→分组→.card-root' : '卡片标签非活动（组件被卸载）',
    tabActive: active,
    groupActive: (group?.className || '').includes('dv-active-group'),
  };
})()`;

const CARD_STATE = `(() => {
  const f = ${FIND_ROOT};
  if (!f.root) return JSON.stringify({ found: false, how: f.how, tabActive: f.tabActive ?? null });
  const body = f.root.querySelector('.markdown-body');
  const bt = body ? body.textContent.replace(/\\s+/g, ' ').trim() : null;
  const pages = [...f.root.querySelectorAll('*')].filter(e => e.children.length === 0 && /^\\d+\\s*\\/\\s*\\d+$/.test((e.textContent || '').trim()));
  return JSON.stringify({
    found: true, how: f.how,
    bodyLen: bt ? bt.length : -1,
    body: bt ? bt.slice(0, 90) : null,
    rootLen: f.root.textContent.trim().length,
    page: pages.length ? pages[pages.length - 1].textContent.trim() : null,
    blocks: body ? body.children.length : -1,
  });
})()`;

const cardState = async () => JSON.parse(await ev(CARD_STATE));

async function waitCardReady(timeoutMs = 20000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await cardState();
    if (last.found && last.bodyLen > 20) return { ok: true, waited: Date.now() - t0, state: last };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, state: last };
}

/** 轮询卡片当前可见卡的文本，等标记出现；返回等待时长 */
async function waitMarker(needle, timeoutMs = 10000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const has = await ev(`(() => {
      const f = ${FIND_ROOT};
      if (!f.root) return false;
      const body = f.root.querySelector('.markdown-body');
      return !!body && body.textContent.includes(${JSON.stringify(needle)});
    })()`);
    if (has) return { ok: true, elapsed: Date.now() - t0, state: await cardState() };
    last = await cardState();
    await sleep(250);
  }
  return { ok: false, elapsed: Date.now() - t0, state: last };
}

async function cardHas(needle) {
  return ev(`(() => {
    const f = ${FIND_ROOT};
    if (!f.root) return 'no-card-root(' + f.how + ')';
    const body = f.root.querySelector('.markdown-body');
    return !!body && body.textContent.includes(${JSON.stringify(needle)});
  })()`);
}

/* ---------------- 步骤 ---------------- */

step(`CDP ${port} 已连接；夹具 ${FIX}（源：testdata/验收样例.md 的拷贝）`);
for (let i = 0; i < 60; i++) {
  if (await ev(`!!window.__fm?.dock`)) break;
  await sleep(500);
}
step(`页面就绪 window.__fm=${await ev(`!!window.__fm`)}；页面里 .card-panel 数=${await ev(`document.querySelectorAll('.card-panel').length`)}`);

// 清掉前一次运行留下的同名面板（只动本夹具的面板）
await ev(`(() => {
  const api = window.__fm.dock;
  for (const p of [...api.panels]) {
    if (p.id.includes(${JSON.stringify(BASE)})) { try { p.api.close(); } catch {} }
  }
  return true;
})()`);
await sleep(500);

/* --- 1. 打开同路径卡片面板，等它 ready --- */
await ev(`window.__fm.openCardPanel(${JSON.stringify(P)}); true`);
const ready1 = await waitCardReady(20000);
const st1 = ready1.state;
check(
  "1 卡片面板就绪（.card-root 存在且正文有内容）",
  ready1.ok,
  `等待 ${ready1.waited}ms；定位=${st1?.how}；正文卡片 ${st1?.page}，第 1 张卡挂 ${st1?.blocks} 个块，文本长度 ${st1?.bodyLen}，开头「${(st1?.body || "").slice(0, 45)}」`,
);

/* --- 2. 打开编辑面板，并把卡片面板挪到右侧分组（两侧同时可见，才能观察自动刷新） --- */
await ev(`window.__fm.openEditPanel(${JSON.stringify(P)}); true`);
for (let i = 0; i < 80; i++) {
  const ok = await ev(`(() => {
    const h = window.__fmEdit?.get?.(${JSON.stringify(P)});
    const root = Array.from(document.querySelectorAll('.edit-pane')).find(e => e.dataset.editPath === ${JSON.stringify(P)});
    return !!(h && root && root.querySelector('.cm-editor') && h.snapshot().metrics.parseMs.length > 0);
  })()`);
  if (ok) break;
  await sleep(250);
}
const layout = JSON.parse(
  await ev(`(() => {
    const api = window.__fm.dock;
    const cp = api.getPanel('card:' + ${JSON.stringify(P)});
    const ep = api.getPanel('edit:' + ${JSON.stringify(P)});
    if (!cp || !ep) return JSON.stringify({ ok: false });
    const before = { sameGroup: cp.group.id === ep.group.id, cardGroup: cp.group.id, editGroup: ep.group.id };
    if (before.sameGroup) {
      const g = api.addGroup({ direction: 'right', referenceGroup: cp.group.id });
      cp.api.moveTo({ group: g });
    }
    cp.api.setActive();
    return JSON.stringify({ ok: true, ...before, afterCardGroup: cp.group.id, cardVisible: cp.api.isVisible, editVisible: ep.api.isVisible });
  })()`),
);
const ready2 = await waitCardReady(15000);
check(
  "2 卡片面板与编辑面板同时可见（并排布局）",
  layout.ok && layout.cardVisible === true && layout.editVisible === true && ready2.ok,
  `卡片分组 ${layout.cardGroup}→${layout.afterCardGroup}，编辑分组 ${layout.editGroup}（原同分组=${layout.sameGroup}）；可见 卡片=${layout.cardVisible} 编辑=${layout.editVisible}；卡片重新就绪 ${ready2.waited}ms（${ready2.state?.page}，${ready2.state?.bodyLen} 字）`,
);

/* --- 3. 在编辑器里插入独特标记（追加到第 1 行，保证落在第 1 张卡上） --- */
const srcLines = readFileSync(FIX, "utf8").split(/\r?\n/);
step(`插入前第 1 行「${srcLines[0]}」`);

const armed = await ev(`(() => {
  const f = ${FIND_ROOT};
  if (!f.root) return 'no-root(' + f.how + ')';
  window.__cardMut = { t0: Date.now(), events: [] };
  window.__cardMutObs?.disconnect();
  const obs = new MutationObserver((recs) => {
    window.__cardMut.events.push({ t: Date.now() - window.__cardMut.t0, n: recs.length });
  });
  obs.observe(f.root, { childList: true, subtree: true, characterData: true });
  window.__cardMutObs = obs;
  return 'armed(' + f.how + ')';
})()`);
step(`卡片内容 DOM 布点：${armed}`);

await ev(`${probe()}.insertAtLine(1, ' ${MARK}'); true`);
await sleep(400);
const editState = JSON.parse((await ev(`JSON.stringify(${probe()}.snapshot())`)) ?? "null");
step(`编辑器 dirty=${editState?.dirty}，冲突=${editState?.conflict ?? "无"}`);

/* --- 4. 保存落盘 --- */
const tSave = Date.now();
await ev(`(async () => { await ${probe()}.save(); })()`);
const saveMs = Date.now() - tSave;
const diskAfter = readFileSync(FIX, "utf8");
const diskHas = diskAfter.includes(MARK);
check(
  "4 保存已落盘（磁盘文件含标记，且只动了 out/ 下的拷贝）",
  diskHas,
  `save() 用时 ${saveMs}ms；mtime=${statSync(FIX).mtimeMs}；文件 ${Buffer.byteLength(diskAfter)} 字节；磁盘第 1 行「${diskAfter.split(/\r?\n/)[0].slice(0, 70)}」`,
);

/* --- 5. 卡片是否自动重跑管线 --- */
const hit = await waitMarker(MARK, 10000);
const mut = JSON.parse(await ev(`JSON.stringify(window.__cardMut || null)`));
const mutSummary = mut
  ? `${mut.events.length} 批变更，首帧 t+${mut.events[0]?.t ?? "-"}ms，末帧 t+${mut.events.at(-1)?.t ?? "-"}ms`
  : "未布点";
const st5 = hit.state;
check(
  "5 保存后卡片正文自动出现标记（预览管线自动重跑）",
  hit.ok,
  `save() 返回到卡片正文命中标记 ${hit.elapsed}ms（上限 10s）；含标记=${await cardHas(MARK)}；卡片正文长度 ${st1?.bodyLen} → ${st5?.bodyLen}；卡片 ${st5?.page}；\n        保存前第 1 张卡开头「${(st1?.body || "").slice(0, 45)}」→ 保存后「${(st5?.body || "").slice(0, 45)}」\n        卡片内容 DOM 变更：${mutSummary}`,
);

/* --- 6（观测+断言）：卡片退回"编辑分组的隐藏标签"时保存，切回标签内容是否最新 --- */
const tabbed = JSON.parse(
  await ev(`(() => {
    const api = window.__fm.dock;
    const cp = api.getPanel('card:' + ${JSON.stringify(P)});
    const ep = api.getPanel('edit:' + ${JSON.stringify(P)});
    cp.api.moveTo({ group: ep.group });
    ep.api.setActive();
    return JSON.stringify({ sameGroup: cp.group.id === ep.group.id, cardVisible: cp.api.isVisible });
  })()`),
);
await sleep(1500);
const hiddenState = await cardState();
await ev(`${probe()}.insertAtLine(1, ' ${MARK2}'); true`);
await sleep(400);
await ev(`(async () => { await ${probe()}.save(); })()`);
await sleep(1200);
const hiddenSave = JSON.parse((await ev(`JSON.stringify(${probe()}.snapshot())`)) ?? "null");
const hiddenUi = JSON.parse((await ev(`JSON.stringify(${probe()}.conflictUi())`)) ?? "null");
const diskHasMark2 = readFileSync(FIX, "utf8").includes(MARK2);
await sleep(2000);
const stillHidden = await cardState();
step(
  `卡片退回隐藏标签：同分组=${tabbed.sameGroup}，卡片可见=${tabbed.cardVisible}，DOM 里本卡片的 .card-root=${hiddenState.found ? "在" : "不在"}（${hiddenState.how}）\n` +
    `        隐藏标签期间插入并保存 ${MARK2}：磁盘含标记=${diskHasMark2}，编辑器 dirty=${hiddenSave?.dirty}、冲突=${hiddenSave?.conflict ?? "无"}，冲突横幅=${hiddenUi?.visible}；2s 后本卡片 .card-root ${stillHidden.found ? "在" : "不在"}`,
);
await ev(`(() => { window.__fm.dock.getPanel('card:' + ${JSON.stringify(P)}).api.setActive(); return true; })()`);
const back = await waitCardReady(15000);
const mark2 = await cardHas(MARK2);
check(
  "6（观测）卡片作为编辑分组的隐藏标签时，切回标签后正文是最新内容",
  hiddenState.found === false && mark2 === true,
  `隐藏期间组件被 dockview 卸载（.card-root 不在 DOM，说明订阅也不存在）；切回后重新就绪 ${back.waited}ms（${back.state?.page}），正文含 ${MARK2}=${mark2}` +
    `\n        → 这条是"挂载即跑管线"的结果，不是隐藏期间的保存广播；用户切回标签看到的仍是最新内容`,
);

/* --- 7（附带）：外部直接写盘能否触发卡片刷新 --- */
await sleep(1000);
const raw = readFileSync(FIX, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const extLines = raw.split(/\r?\n/);
extLines[0] = `${extLines[0]} ${MARK_EXT}`;
writeFileSync(FIX, extLines.join(eol), "utf8");
const ext = await waitMarker(MARK_EXT, 10000);
check(
  "7（附带）外部改盘（writeFileSync 改写第 1 行）触发卡片刷新",
  ext.ok,
  ext.ok
    ? `写盘到卡片正文出现新内容 ${ext.elapsed}ms（期间无任何编辑器操作）；含 ${MARK_EXT}=${await cardHas(MARK_EXT)}；卡片 ${ext.state?.page}，开头「${(ext.state?.body || "").slice(0, 45)}」`
    : `等待 ${ext.elapsed}ms 未命中；含 ${MARK_EXT}=${await cardHas(MARK_EXT)}；卡片第 1 张卡开头「${(ext.state?.body || "").slice(0, 45)}」`,
);

/* --- 8：不调 save()，走编辑器自己的空闲自动保存（AUTOSAVE_MS=1000） --- */
const MARK3 = "卡片刷新验证 MARK6393";
await ev(`(() => { window.__fm.dock.getPanel('edit:' + ${JSON.stringify(P)}).api.setActive(); return true; })()`);
await sleep(1500); // 编辑面板重新挂载
for (let i = 0; i < 40; i++) {
  if (await ev(`!!window.__fmEdit?.get?.(${JSON.stringify(P)})`)) break;
  await sleep(250);
}
const layout8 = JSON.parse(
  await ev(`(() => {
    const api = window.__fm.dock;
    const cp = api.getPanel('card:' + ${JSON.stringify(P)});
    const ep = api.getPanel('edit:' + ${JSON.stringify(P)});
    if (cp.group.id === ep.group.id) {
      const g = api.addGroup({ direction: 'right', referenceGroup: cp.group.id });
      cp.api.moveTo({ group: g });
    }
    cp.api.setActive();
    return JSON.stringify({ cardVisible: cp.api.isVisible, editVisible: ep.api.isVisible });
  })()`),
);
await sleep(1200);
await ev(`(() => { window.__fm.dock.getPanel('edit:' + ${JSON.stringify(P)}).api.setActive(); return true; })()`);
const ready8 = await waitCardReady(15000);
const tAuto = Date.now();
await ev(`${probe()}.insertAtLine(1, ' ${MARK3}'); true`);
let autoSaveMs = -1;
for (let i = 0; i < 40; i++) {
  if (readFileSync(FIX, "utf8").includes(MARK3)) {
    autoSaveMs = Date.now() - tAuto;
    break;
  }
  await sleep(200);
}
const auto = await waitMarker(MARK3, 10000);
check(
  "8 连续编辑（不显式保存）经 1s 空闲自动保存后卡片自动刷新",
  layout8.cardVisible && layout8.editVisible && autoSaveMs > 0 && auto.ok,
  `两侧可见 卡片=${layout8.cardVisible} 编辑=${layout8.editVisible}（卡片就绪 ${ready8.waited}ms）；改动到磁盘出现标记 ${autoSaveMs}ms（AUTOSAVE_MS=1000）；磁盘落盘到卡片正文命中标记 ${auto.elapsed}ms；含 ${MARK3}=${await cardHas(MARK3)}`,
);

/* --- 汇总 --- */
const finalState = await cardState();
step(`最终卡片：${finalState?.page}，正文长度 ${finalState?.bodyLen}，开头「${(finalState?.body || "").slice(0, 45)}」`);
if (consoleErrors.length) {
  console.log("[CONSOLE] 错误（去重前 6 条）：");
  for (const e of [...new Set(consoleErrors)].slice(0, 6)) console.log("  -", e);
}
note(`磁盘夹具最终 ${Buffer.byteLength(readFileSync(FIX, "utf8"))} 字节；仓库受版本控制文件 testdata/验收样例.md 未被改动（本脚本只读写 out/ 下的拷贝）`);
console.log(`\n=== 汇总：${steps.filter((s) => s.ok).length} 通过 / ${failures} 失败 ===`);
console.log(JSON.stringify({ failures, steps }, null, 1));

try {
  await client.close();
} catch {
  /* ignore */
}
process.exit(failures === 0 ? 0 : 1);
