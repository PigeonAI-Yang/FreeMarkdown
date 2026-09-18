// 编辑功能 阶段 1 验收探针（编辑面板 + 分栏预览 + 保存链路）。
//
// 前置条件：应用带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
// 运行（dev 模式），vite dev server（1420）存活。
//   node scripts/edit-probe.mjs            跑全部检查
//   node scripts/edit-probe.mjs C2 C3      只跑指定编号（便于复跑）
//
// 口径来自 docs/编辑功能方案.md 阶段 1 验收表：每条打印原始测量值，不做"看起来没问题"的判断。
// 注意：C9 会强杀应用进程（原子性检查），所以它固定排在最后。
import CDP from "chrome-remote-interface";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9223);
const ROOT = "J:/PigeonYang/FreeMarkdown";
const OUT = join(ROOT, "testdata", "out");
const BIG_SRC = join(ROOT, "testdata", "big", "big1.md");
const BIG = join(OUT, "edit-2mb.md");
const CRLF = join(OUT, "edit-crlf-bom.md");
const CONFLICT = join(OUT, "edit-conflict.md");
const CACHE = join(OUT, "edit-cache.md");
// 只开编辑面板、没有阅读面板的独立夹具：用来测"保存后首读未命中 → 再读命中"的纯缓存链
const CACHE2 = join(OUT, "edit-cache2.md");
const SAVEAS = join(OUT, "edit-saveas.md");
// 验收样例以仓库里的那份为源，运行前拷到 out/ 再编辑：探针会真实键入并自动保存，
// 直接改仓库夹具会把测试痕迹留在受版本控制的文件里。
const SAMPLE = join(OUT, "验收样例.md");
mkdirSync(OUT, { recursive: true });
copyFileSync(join(ROOT, "testdata", "验收样例.md"), SAMPLE);

const only = process.argv.slice(2).filter((a) => /^C\d/.test(a));
const shouldRun = (id) => only.length === 0 || only.includes(id);
const results = [];
let pass = 0;
let fail = 0;

function record(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  if (ok) pass++;
  else fail++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id} ${name}\n        ${detail ?? ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
}
const median = (arr) => percentile(arr, 50);

/* ---------------- 夹具 ---------------- */

mkdirSync(OUT, { recursive: true });
copyFileSync(BIG_SRC, BIG);
writeFileSync(
  CRLF,
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("# CRLF 测试\r\n\r\n第一段正文\r\n\r\n第二段正文\r\n", "utf8"),
  ]),
);
writeFileSync(CONFLICT, "v1\n\n冲突测试\n", "utf8");
writeFileSync(CACHE, "# 缓存链\n\n初始内容\n", "utf8");
writeFileSync(CACHE2, "# 缓存链 2\n\n初始内容\n", "utf8");
if (existsSync(SAVEAS)) rmSync(SAVEAS);

console.log("=== 编辑功能 阶段 1 验收 ===");
console.log(`2MB 夹具：${BIG}（${statSync(BIG).size} B）\n`);

/* ---------------- CDP 通道 ---------------- */

const client = await CDP({ port, wait: true });
const { Runtime, Page, Input, Log } = client;
await Runtime.enable();
await Page.enable();
await Log.enable();
const consoleErrors = [];
Log.entryAdded((e) => {
  if (e.entry.level === "error") consoleErrors.push(String(e.entry.text).slice(0, 200));
});
Runtime.exceptionThrown((e) =>
  consoleErrors.push(
    String(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "").slice(0, 300),
  ),
);

async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval failed",
    );
  }
  return r.result.value;
}

const bslash = (p) => p.replace(/\//g, "\\");
const probe = (p) => `window.__fmEdit.get(${JSON.stringify(bslash(p))})`;

/* 等应用就绪：dev 期热更新会整页 reload；若模块版本错位（HMR 残留）会出现
   "booted 为真但根节点渲染为空"的状态，此时硬刷新一次即可自愈。 */
{
  const readyExpr = `!!(window.__fm && window.__fm.dock && window.__fm.appStore?.get().booted
    && document.getElementById('root') && document.getElementById('root').innerHTML.length > 1000)`;
  let ready = false;
  let reloads = 0;
  for (let i = 0; i < 120; i++) {
    try {
      ready = await ev(readyExpr);
    } catch {
      ready = false;
    }
    if (ready) break;
    if (reloads < 3 && (i === 8 || i === 30 || i === 60)) {
      reloads++;
      console.log(`（应用未就绪：硬刷新页面后重试 ${reloads}/3）`);
      await Page.reload({ ignoreCache: true });
      await sleep(3000);
    }
    await sleep(500);
  }
  if (!ready) {
    console.log("[FAIL] 应用未就绪：__fm.dock 为空或根节点未渲染（重试 3 次硬刷新后仍失败）");
    process.exit(1);
  }
}

/* 起始清理：关掉上一轮遗留的编辑/卡片面板与重复的阅读面板。
   面板堆积会让全局选择器（.cm-editor / .edit-pane）拿到别的面板，把断言带偏。 */
await ev(`(async () => {
  const api = window.__fm.dock;
  for (const p of [...api.panels]) {
    if (p.id.startsWith('edit:') || p.id.startsWith('card:')) {
      try { p.api.close(); } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
  }
  const seen = new Set();
  for (const p of [...api.panels]) {
    if (!p.id.startsWith('doc:')) continue;
    const key = p.id.slice(4);
    if (seen.has(key)) { try { p.api.close(); } catch {} await new Promise(r => setTimeout(r, 80)); }
    else seen.add(key);
  }
  return api.panels.length;
})()`);
await sleep(500);

/** 注入页面侧工具：sha256（用于大文本比对）与长任务观察器 */
await ev(`(() => {
  window.__sha = async (t) => {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
  };
  window.__lt = [];
  if (!window.__ltObs) {
    window.__ltObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
    });
    window.__ltObs.observe({ type: 'longtask', buffered: false });
  }
  return true;
})()`);

async function openEditPanel(path, timeoutMs = 15000) {
  await ensureApp();
  return ev(`(async () => {
    const p = ${JSON.stringify(bslash(path))};
    const api = window.__fm.dock;
    if (!api) return { ms: -1, diag: { err: 'dock 未就绪（页面还在加载）' } };
    const t0 = performance.now();
    window.__fm.openEditPanel(p);
    for (let i = 0; i < ${Math.ceil(timeoutMs / 20)}; i++) {
      await new Promise(r => setTimeout(r, 20));
      const h = window.__fmEdit?.get?.(p);
      const sn = h ? h.snapshot() : null;
      // 按 dataset 找面板：Windows 路径不能进 CSS 属性选择器（反斜杠是 CSS 转义）
      const root = Array.from(document.querySelectorAll('.edit-pane')).find(e => e.dataset.editPath === p);
      if (sn && root && root.querySelector('.cm-editor') && sn.metrics.parseMs.length > 0) {
        return { ms: Math.round(performance.now() - t0), blocks: sn.blocks, mounted: sn.mounted,
                 parseMs: sn.metrics.parseMs[0], openMs: Math.round(sn.metrics.openMs),
                 eol: sn.eol, bom: sn.bom, size: sn.size, panels: api.panels.length };
      }
    }
    const ep = api.panels.find(x => x.id.startsWith('edit:'));
    return { ms: -1, diag: { panels: api.panels.map(x => x.id.slice(0, 30)),
      visible: ep ? ep.api.isVisible : null, activePath: window.__fm.appStore.get().activePanelPath,
      probes: window.__fmEdit ? window.__fmEdit.paths() : null, cm: document.querySelectorAll('.cm-editor').length } };
  })()`);
}

/** 每个检查段开始前确认应用健康（dev 期偶发模块版本错位会让根节点白屏，硬刷新可自愈） */
async function ensureApp() {
  const okExpr = `!!(window.__fm && window.__fm.dock && document.getElementById('root') && document.getElementById('root').innerHTML.length > 1000)`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let ok = false;
    try {
      ok = await ev(okExpr);
    } catch {
      ok = false;
    }
    if (ok) return true;
    console.log("        （应用未就绪，硬刷新后重试）");
    await Page.reload({ ignoreCache: true });
    await sleep(4000);
  }
  return false;
}

/** 关掉残留的编辑面板再打开：避免复用到上一轮遗留的冻结快照（旧 mtime 会造成假冲突） */
async function reopenEdit(path) {
  await ev(`(async () => {
    const api = window.__fm.dock, p = ${JSON.stringify(bslash(path))};
    const ep = api.getPanel('edit:' + p);
    if (ep) {
      ep.api.close();
      await new Promise(r => setTimeout(r, 350));
    }
    return true;
  })()`);
  await sleep(300); // 等面板关闭后的会话快照清理定时器跑完
  const opened = await openEditPanel(path);
  await activate(path);
  return opened;
}

async function activate(path) {
  await ensureApp();
  return ev(`(async () => {
    const p = ${JSON.stringify(bslash(path))};
    const api = window.__fm.dock;
    const ep = api.getPanel('edit:' + p) || api.panels.find(x => x.id.startsWith('edit:'));
    if (!ep) return false;
    ep.api.setActive();
    ep.group.api.setActive();
    // 按 dataset 找面板：Windows 路径不能进 CSS 属性选择器（反斜杠是 CSS 转义）
    const paneEl = () => Array.from(document.querySelectorAll('.edit-pane')).find(e => e.dataset.editPath === p);
    for (let i = 0; i < 400; i++) {
      await new Promise(r => setTimeout(r, 25));
      const root = paneEl();
      const h = window.__fmEdit?.get?.(p);
      if (root && root.querySelector('.cm-editor') && h && h.snapshot().metrics.parseMs.length > 0) {
        return true;
      }
    }
    return false;
  })()`);
}

async function activatePanelById(id) {
  await ensureApp();
  return ev(`(async () => {
    const ep = window.__fm.dock.panels.find(x => x.id === ${JSON.stringify(id)});
    if (!ep) return false;
    ep.api.setActive();
    ep.group.api.setActive();
    await new Promise(r => setTimeout(r, 150));
    return true;
  })()`);
}

/** 把焦点放到编辑区（CDP insertText 只落到 document.activeElement） */
/**
 * 把焦点放到指定编辑面板的编辑区（CDP insertText / 按键只落到 document.activeElement）。
 * 必须按面板路径取节点：同屏可能有多个编辑面板，querySelector 会拿到错的那个。
 */
async function focusEditor(path) {
  await ensureApp();
  return ev(`(() => {
    const root = Array.from(document.querySelectorAll('.edit-pane')).find(e => e.dataset.editPath === ${JSON.stringify(bslash(path))});
    const el = root ? root.querySelector('.edit-editor .cm-content') : null;
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
}

async function syncAndSave(path, opts = {}) {
  return ev(`(async () => {
    const h = ${probe(path)};
    await h.sync();
    await h.save(${opts.force ?? "undefined"});
    const sn = h.snapshot();
    return { dirty: sn.dirty, conflict: sn.conflict, saveState: document.querySelector('[data-save-state]')?.dataset.saveState ?? null };
  })()`);
}

function fileFacts(p) {
  const raw = readFileSync(p);
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const body = bom ? raw.subarray(3) : raw;
  const text = body.toString("utf8");
  return {
    bytes: raw.length,
    bom,
    crlf: text.includes("\r\n"),
    bareLf: /(^|[^\r])\n/.test(text),
    normHash: crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
    text,
  };
}

function tmpLeftovers(target) {
  const dir = join(target, "..");
  const name = target.split(/[\\/]/).pop();
  try {
    return readdirSync(dir).filter((f) => f.startsWith(`.${name}.fm-tmp-`));
  } catch {
    return [];
  }
}

/* ================= C1：2MB 进入编辑 + 连打无长帧 ================= */

if (shouldRun("C1")) {
  // 关掉可能已存在的编辑面板，测「从零打开」的真实数字
  await ev(`window.__fm.dock.getPanel('edit:' + ${JSON.stringify(bslash(BIG))})?.api.close(); true`);
  await sleep(400);
  const open = await openEditPanel(BIG);
  record(
    "C1a",
    "2MB 文档进入编辑并块就绪 ≤1s",
    open.ms > 0 && open.ms <= 1000,
    `面板点击 → 块可注入 ${open.ms}ms；Rust 整篇 parse ${open.parseMs}ms；块数 ${open.blocks}；DOM 挂载 ${open.mounted}${open.diag ? "；诊断 " + JSON.stringify(open.diag) : ""}`,
  );
  record(
    "C1b",
    "预览窗口化：DOM 块数远小于总块数",
    open.blocks > 2000 && open.mounted < 200,
    `总块 ${open.blocks} / 挂载 ${open.mounted}`,
  );

  const act1 = await activate(BIG);
  if (!act1) record("C1a0", "编辑面板可激活（编辑器挂载）", false, "activate() 超时");
  const focused = await focusEditor(BIG);
  const len0 = await ev(`${probe(BIG)}.text().length`);
  await ev(`window.__lt = []; true`);
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    await Input.insertText({ text: "字" });
    await sleep(20);
  }
  const typeMs = Date.now() - t0;
  const len1 = await ev(`${probe(BIG)}.text().length`);
  await sleep(900);
  const lt = JSON.parse((await ev(`JSON.stringify(window.__lt)`)) ?? "[]");
  const over50 = lt.filter((d) => d > 50);
  record(
    "C1c0",
    "CDP 真实键入确实进入编辑器（100 字符全部落到缓冲）",
    focused && len1 - len0 === 100,
    `焦点在编辑区 ${focused}；缓冲 ${len0} → ${len1}（+${len1 - len0}）`,
  );
  record(
    "C1c",
    "连打 100 字符期间无长帧（>50ms 长任务 0 次）",
    over50.length === 0,
    `连打耗时 ${typeMs}ms；长任务 ${lt.length} 次，其中 >50ms ${over50.length} 次${lt.length ? `，最长 ${Math.max(...lt)}ms` : ""}`,
  );
  await ev(`(async () => { await ${probe(BIG)}.sync(); })()`);
}

/* ================= C2/C3：单键延迟与 IPC 载荷 ================= */

if (shouldRun("C2") || shouldRun("C3")) {
  await activate(BIG);
  const focused2 = await focusEditor(BIG);
  const len2 = await ev(`${probe(BIG)}.text().length`);
  const before = JSON.parse((await ev(`JSON.stringify(${probe(BIG)}.snapshot().metrics)`)) ?? "{}");
  const SAMPLES = 30;
  for (let i = 0; i < SAMPLES; i++) {
    await Input.insertText({ text: "测" });
    await sleep(230);
  }
  await sleep(500);
  const len3 = await ev(`${probe(BIG)}.text().length`);
  const after = JSON.parse((await ev(`JSON.stringify(${probe(BIG)}.snapshot().metrics)`)) ?? "{}");
  const lat = (after.keystrokes ?? []).slice((before.keystrokes ?? []).length);
  const payloads = (after.payloads ?? []).slice((before.payloads ?? []).length);
  const p95 = percentile(lat, 95);
  const maxPayload = payloads.length ? Math.max(...payloads) : 0;
  const parseSlice = (after.parseMs ?? []).slice((before.parseMs ?? []).length);

  if (shouldRun("C2")) {
    record(
      "C2",
      "单键 → 预览块更新 P95 ≤150ms（含 IPC 往返与 DOM 注入）",
      lat.length >= SAMPLES - 5 && p95 <= 150,
      `样本 ${lat.length}；P50 ${percentile(lat, 50)}ms，P95 ${p95}ms，最大 ${lat.length ? Math.max(...lat) : "-"}ms；Rust 切片 parse 中位 ${median(parseSlice)}ms，最大 ${parseSlice.length ? Math.max(...parseSlice) : "-"}ms；键入生效 ${focused2 && len3 - len2 === SAMPLES}（缓冲 ${len2} → ${len3}）`,
    );
  }
  if (shouldRun("C3")) {
    record(
      "C3",
      "单键 IPC 载荷 ≤32KB 且不随文档体量增长",
      maxPayload > 0 && maxPayload <= 32 * 1024,
      `最大 ${maxPayload} B，中位 ${median(payloads)} B（2MB 文档；整篇兜底 ${(after.fullRenders ?? 0) - (before.fullRenders ?? 0)} 次）`,
    );
  }
}

/* ================= C4：保存正确性（逐字节 + CRLF/BOM） ================= */

if (shouldRun("C4")) {
  await openEditPanel(CRLF);
  await activate(CRLF);
  await ev(`${probe(CRLF)}.insertAtStart('插入了一行\\n\\n'); true`);
  await sleep(400);
  const res = await ev(`(async () => {
    const h = ${probe(CRLF)};
    await h.sync();
    await h.save();
    const sn = h.snapshot();
    const t = h.text();
    return { dirty: sn.dirty, state: document.querySelector('[data-save-state]')?.dataset.saveState, hash: await window.__sha(t), len: t.length, head: t.slice(0, 10) };
  })()`);
  const facts = fileFacts(CRLF);
  record(
    "C4a",
    "保存后文件与缓冲逐字节一致，BOM/CRLF 原样保持",
    facts.bom && facts.crlf && !facts.bareLf && facts.normHash === res.hash && res.dirty === false,
    `文件 ${facts.bytes} B（BOM ${facts.bom}、CRLF ${facts.crlf}、裸 LF ${facts.bareLf}）；规范化哈希一致 ${facts.normHash === res.hash}；缓冲 ${res.len} 字符，首段 ${JSON.stringify(res.head)}`,
  );
  record(
    "C4b",
    "保存内容确实是编辑后的缓冲（不是原文件回写）",
    String(res.head).startsWith("插入了一行"),
    `缓冲开头 ${JSON.stringify(res.head)}`,
  );
  record("C4c", "写盘不留临时文件", tmpLeftovers(CRLF).length === 0, `残留 ${tmpLeftovers(CRLF).length} 个`);
  const bigFacts = fileFacts(BIG);
  record(
    "C4d",
    "LF 文档保存后不引入 CRLF / BOM",
    !bigFacts.bom && !bigFacts.crlf && !bigFacts.bareLf === false,
    `2MB 文档：BOM ${bigFacts.bom}、CRLF ${bigFacts.crlf}、含 LF ${!bigFacts.bareLf}`,
  );
}

/* ================= C5：冲突三选项 ================= */

if (shouldRun("C5")) {
  await openEditPanel(CONFLICT);
  await activate(CONFLICT);
  await ev(`${probe(CONFLICT)}.insertAtStart('本地改动 A\\n\\n'); true`);
  await sleep(1300); // 先让空闲自动保存跑一轮（清掉脏标记）
  writeFileSync(CONFLICT, "外部改动 v2\n", "utf8"); // 模拟外部程序改写
  await sleep(60);
  await ev(`${probe(CONFLICT)}.insertAtStart('本地改动 B\\n'); true`);
  const s1 = await syncAndSave(CONFLICT);
  const ui = await ev(`(async () => JSON.stringify(${probe(CONFLICT)}.conflictUi()))()`);
  const uiObj = JSON.parse(ui ?? "null");
  const disk1 = readFileSync(CONFLICT, "utf8");
  record(
    "C5a",
    "外部改动后保存 → 出冲突提示、三个选项、不静默覆盖",
    s1.conflict != null && uiObj?.visible && uiObj.buttons.length === 3 && disk1 === "外部改动 v2\n",
    `冲突 mtime ${s1.conflict}；面板可见 ${uiObj?.visible}；按钮 [${uiObj?.buttons?.join(" / ")}]；磁盘仍为外部内容 ${disk1 === "外部改动 v2\n"}`,
  );

  await ev(`${probe(CONFLICT)}.clickConflict('覆盖'); true`);
  await sleep(700);
  const s2 = JSON.parse((await ev(`JSON.stringify(${probe(CONFLICT)}.snapshot())`)) ?? "null");
  const buf2 = await ev(`${probe(CONFLICT)}.text()`);
  const disk2 = readFileSync(CONFLICT, "utf8");
  record(
    "C5b",
    "「覆盖」：缓冲写入磁盘、冲突与脏标记清空",
    s2?.conflict == null && s2?.dirty === false && disk2 === buf2,
    `冲突 ${s2?.conflict}；dirty ${s2?.dirty}；磁盘 = 缓冲 ${disk2 === buf2}`,
  );

  await ev(`${probe(CONFLICT)}.insertAtStart('本地改动 C\\n'); true`);
  writeFileSync(CONFLICT, "磁盘 v3\n", "utf8");
  await syncAndSave(CONFLICT);
  await ev(`${probe(CONFLICT)}.clickConflict('重新载入'); true`);
  await sleep(1000);
  const s3 = JSON.parse((await ev(`JSON.stringify(${probe(CONFLICT)}.snapshot())`)) ?? "null");
  const buf3 = await ev(`${probe(CONFLICT)}.text()`);
  record(
    "C5c",
    "「重新载入」：用磁盘内容替换缓冲、丢弃本地改动",
    buf3 === "磁盘 v3\n" && s3?.conflict == null && s3?.dirty === false,
    `缓冲 ${JSON.stringify(String(buf3).slice(0, 12))}；冲突 ${s3?.conflict}；dirty ${s3?.dirty}`,
  );

  // 另存为：原生文件对话框无法自动化，这里验证其落盘路径（expect_mtime=null → 新文件）
  const sa = await ev(`(async () => {
    const t = window.__fmIpc;
    const p = ${JSON.stringify(bslash(SAVEAS))};
    const txt = ${probe(CONFLICT)}.text();
    const r = await t.writeMarkdown(p, txt, null, 'lf', false);
    return { bytes: r.bytes, txt };
  })()`);
  const saFacts = existsSync(SAVEAS) ? fileFacts(SAVEAS) : null;
  record(
    "C5d",
    "「另存为」落盘路径可用（expect_mtime=null 新建文件、内容一致）",
    !!saFacts && saFacts.text === sa.txt,
    `新文件 ${saFacts?.bytes ?? "缺失"} B；内容一致 ${saFacts?.text === sa.txt}；按钮存在性见 C5a（原生对话框不可自动化）`,
  );
}

/* ================= C6：缓存链（阅读面板刷新 + 新 mtime 命中） ================= */

/** 轮询等待页面条件成立，返回条件值 */
async function waitFor(cond, timeoutMs = 6000, stepMs = 150) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await ev(`(${cond})`);
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

if (shouldRun("C6")) {
  const P = bslash(CACHE);
  // 场景：左分组阅读 + 右分组编辑，同屏可见（同路径多面板）。
  // 先关掉可能残留的阅读面板，避免复用到上一轮遗留的 DOM（内容是旧的）
  await ev(`(async () => {
    const api = window.__fm.dock, p = ${JSON.stringify(P)};
    const old = api.getPanel('doc:' + p);
    if (old) { old.api.close(); await new Promise(r => setTimeout(r, 250)); }
    return true;
  })()`);
  await ev(`window.__fm.openFile(${JSON.stringify(P)}); true`);
  await sleep(700);
  await ev(`(async () => {
    const api = window.__fm.dock, p = ${JSON.stringify(P)};
    const dp = api.getPanel('doc:' + p);
    if (!dp) return { err: 'no doc panel' };
    dp.api.setActive();
    dp.group.api.setActive();
    await new Promise(r => setTimeout(r, 400));
    const ep = api.getPanel('edit:' + p);
    if (ep) { ep.api.close(); await new Promise(r => setTimeout(r, 250)); }
    api.addPanel({ id: 'edit:' + p, component: 'edit', title: '编辑 · 缓存链',
      params: { path: p }, position: { referencePanel: dp.id, direction: 'right' } });
    await new Promise(r => setTimeout(r, 400));
    return { groups: api.groups.length, sameGroup: api.getPanel('edit:' + p)?.group.id === dp.group.id };
  })()`);
  await activate(CACHE);
  await sleep(600);
  // 阅读面板挂载是异步的（重开/重读），等它真的出现在 DOM 里
  await waitFor(`Array.from(document.querySelectorAll('.doc-content')).some(e => e.dataset.path === ${JSON.stringify(P)})`, 8000);

  // 注意：Windows 路径不能直接拼进 CSS 属性选择器（反斜杠是 CSS 转义），按 dataset 比对
  const readerProbe = `(() => {
    const el = Array.from(document.querySelectorAll('.doc-content')).find(e => e.dataset.path === ${JSON.stringify(P)});
    if (!el) return { visible: false, has: null, text: "" };
    const r = el.getBoundingClientRect();
    return { visible: r.height > 50, text: el.innerText.slice(0, 60), has: el.innerText.includes('缓存链标记 ZQ7') };
  })()`;
  const rBefore = await ev(readerProbe);
  record(
    "C6a0",
    "场景就绪：阅读面板与编辑面板同屏（不同分组，都可见）",
    rBefore?.visible === true && rBefore?.has === false,
    `阅读面板可见高度 >50px：${rBefore?.visible}；保存前含标记 ${rBefore?.has}；首段 ${JSON.stringify(String(rBefore?.text ?? "").slice(0, 18))}`,
  );

  await ev(`${probe(CACHE)}.insertAtStart('缓存链标记 ZQ7' + String.fromCharCode(10, 10)); true`);
  await sleep(400);
  await ev(`(async () => { const h = ${probe(CACHE)}; await h.sync(); await h.save(); })()`);
  // 保存广播 → 阅读面板重读（重读期间内容会先清空），等标记出现
  await waitFor(`(() => { const el = Array.from(document.querySelectorAll('.doc-content')).find(e => e.dataset.path === ${JSON.stringify(P)}); return !!el && el.innerText.includes('缓存链标记 ZQ7'); })()`, 8000);

  const rAfter = await ev(readerProbe);
  record(
    "C6a",
    "保存 → 同路径阅读面板内容刷新（按新 mtime 重读）",
    rAfter?.has === true,
    `刷新后含标记 ${rAfter?.has}；首段 ${JSON.stringify(String(rAfter?.text ?? "").slice(0, 22))}`,
  );

  // 纯缓存链（同路径只开编辑面板，不被阅读面板提前填充缓存）：
  // 保存 → mtime 变化 → 首读未命中、再读命中，内容是新写的
  const P2 = bslash(CACHE2);
  await reopenEdit(CACHE2);
  await ev(`${probe(CACHE2)}.insertAtStart('缓存链标记 B1' + String.fromCharCode(10, 10)); true`);
  await sleep(300);
  const saveC2 = await ev(`(async () => {
    const h = ${probe(CACHE2)};
    await h.sync();
    await h.save();
    const sn = h.snapshot();
    return { dirty: sn.dirty, conflict: sn.conflict, buf: h.text().slice(0, 16) };
  })()`);
  await sleep(400);
  const diskC2 = readFileSync(CACHE2, "utf8");
  const c2 = await ev(`(async () => {
    const p = ${JSON.stringify(P2)};
    const a = await window.__fmIpc.readMarkdown(p);
    const b = await window.__fmIpc.readMarkdown(p);
    return { first: a.fromCache, second: b.fromCache, mtime: a.mtimeMs,
             hasA: (a.chunks || []).join('').includes('缓存链标记 B1'),
             hasB: (b.chunks || []).join('').includes('缓存链标记 B1'),
             headA: (a.chunks || []).join('').slice(0, 36) };
  })()`);
  record(
    "C6b",
    "保存后重开：首读未命中 → 再读命中（缓存键为新的 mtime），内容是新写的那份",
    c2.first === false &&
      c2.second === true &&
      c2.hasA &&
      c2.hasB &&
      diskC2.includes("缓存链标记 B1"),
    `首次 fromCache=${c2.first}、二次 ${c2.second}；mtime=${c2.mtime}；读到的内容含新改动 ${c2.hasA}/${c2.hasB}；磁盘含新改动 ${diskC2.includes("缓存链标记 B1")}；缓冲 ${JSON.stringify(String(saveC2?.buf ?? ""))}；dirty ${saveC2?.dirty} / 冲突 ${saveC2?.conflict}；HTML ${JSON.stringify(String(c2.headA ?? "").slice(0, 30))}`,
  );
}

/* ================= C7：冻结恢复（光标 + 视口，冻结期不挂 DOM） ================= */

if (shouldRun("C7")) {
  // 单独跑 C7 时编辑面板可能还没开（C1 才会开），这里补齐场景
  await openEditPanel(BIG);
  await activate(BIG);
  const focused7 = await focusEditor(BIG);
  // 真实按键（↓ × 40）把光标推到几十行之外，制造非平凡的"光标 + 视口"现场
  for (let i = 0; i < 40; i++) {
    await Input.dispatchKeyEvent({
      type: "rawKeyDown",
      windowsVirtualKeyCode: 40,
      key: "ArrowDown",
      code: "ArrowDown",
    });
    await Input.dispatchKeyEvent({
      type: "keyUp",
      windowsVirtualKeyCode: 40,
      key: "ArrowDown",
      code: "ArrowDown",
    });
  }
  await sleep(800);
  // 再把视口推到文档深处（光标 + 滚动都变成非平凡现场）
  await ev(`(() => {
    const h = ${probe(BIG)};
    const lines = h.blockLines();
    h.gotoLine(lines[Math.floor(lines.length * 0.6)].start);
    return true;
  })()`);
  await sleep(900);
  const before = JSON.parse((await ev(`JSON.stringify(${probe(BIG)}.cursor())`)) ?? "null");
  const bufBefore = await ev(`${probe(BIG)}.text().length`);
  const panesBefore = JSON.parse(
    (await ev(`JSON.stringify({ cm: document.querySelectorAll('.cm-editor').length, pane: document.querySelectorAll('.edit-pane').length })`)) ?? "{}",
  );

  const docPanel = await ev(`window.__fm.dock.panels.find(p => p.id.startsWith('doc:'))?.id ?? null`);
  await activatePanelById(docPanel);
  await sleep(1000);
  const frozen = JSON.parse(
    (await ev(`JSON.stringify({
      cm: document.querySelectorAll('.cm-editor').length,
      pane: document.querySelectorAll('.edit-pane').length,
      placeholder: document.querySelectorAll('.frozen-placeholder').length,
      probe: typeof window.__fmEdit?.get?.(${JSON.stringify(bslash(BIG))}),
      paneEl: document.querySelectorAll('.edit-pane[data-edit-path="' + ${JSON.stringify(bslash(BIG))} + '"]').length
    })`)) ?? "{}",
  );
  const cmDrop = (panesBefore.cm ?? 0) - (frozen.cm ?? 0);
  record(
    "C7a",
    "冻结期间不挂 DOM（编辑器实例与节点全部销毁）",
    focused7 &&
      frozen.probe === "undefined" &&
      cmDrop === 1 &&
      frozen.paneEl === 0 &&
      frozen.placeholder >= 0,
    `光标已就位 ${focused7}；冻结后 .cm-editor ${panesBefore.cm} → ${frozen.cm}（-${cmDrop}）、.edit-pane ${panesBefore.pane} → ${frozen.pane}；本面板 DOM ${frozen.paneEl} 个；探针句柄 ${frozen.probe}；冻结占位 ${frozen.placeholder}（dockview 直接卸载非活动标签，占位符只在分组失活等路径出现）`,
  );

  await activate(BIG);
  await sleep(1200);
  const after = JSON.parse((await ev(`JSON.stringify(${probe(BIG)}.cursor())`)) ?? "null");
  const bufAfter = await ev(`${probe(BIG)}.text().length`);
  record(
    "C7b0",
    "现场是非平凡的（光标不在首行、视口已滚离顶部）",
    before?.line > 5 && before?.scrollTop > 100,
    `冻结前光标 ${before?.line}:${before?.col}，滚动 ${before?.scrollTop}px`,
  );
  record(
    "C7b",
    "切回后光标与编辑器视口恢复（行/列一致、滚动差 ≤2px）",
    after?.line === before?.line &&
      after?.col === before?.col &&
      Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0)) <= 2,
    `光标 ${before?.line}:${before?.col} → ${after?.line}:${after?.col}；滚动 ${before?.scrollTop} → ${after?.scrollTop}`,
  );
  record(
    "C7c",
    "冻结恢复不丢缓冲（文本长度一致）",
    bufAfter === bufBefore && bufAfter > 1_000_000,
    `缓冲 ${bufBefore} → ${bufAfter} 字符`,
  );
}

/* ================= C8：既有链路回归 ================= */

if (shouldRun("C8")) {
  // C8b 要求"编辑窗格与卡片窗格同时在场"，而阅读面板与编辑面板若在同一个分组里，
  // 非活动的那个不挂 DOM（冻结策略）——这个场景由 C1/C6 建立的布局提供。
  // 单独跑这一项时请连 C1 一起跑：node scripts/edit-probe.mjs C1 C8
  await ev(`window.__fm.openFile(${JSON.stringify(bslash(SAMPLE))}); true`);
  await sleep(400);
  await ev(`(async () => {
    const dp = window.__fm.dock.getPanel('doc:' + ${JSON.stringify(bslash(SAMPLE))});
    if (dp) { dp.api.setActive(); dp.group.api.setActive(); }
    await new Promise(r => setTimeout(r, 300));
    return true;
  })()`);
  await sleep(1500);
  const check = await ev(`(async () => {
    const el = Array.from(document.querySelectorAll('.doc-content')).find(e => e.dataset.path === ${JSON.stringify(bslash(SAMPLE))});
    if (!el) return { err: 'no doc content' };
    for (let i = 0; i < 60 && !el.querySelector('.katex'); i++) await new Promise(r => setTimeout(r, 100));
    return {
      katex: el.querySelectorAll('.katex').length,
      mermaid: el.querySelectorAll('.mermaid-host').length,
      hl: el.querySelectorAll('pre code.hljs').length,
      task: el.querySelectorAll('input[type="checkbox"]').length,
      table: el.querySelectorAll('table').length,
      toc: (window.__fm.appStore.get().tocMap[${JSON.stringify(bslash(SAMPLE))}] || []).length
    };
  })()`);
  record(
    "C8a",
    "阅读面板渲染管线回归（KaTeX / mermaid / 高亮 / 任务列表 / 表格 / 目录）",
    check.katex > 0 && check.mermaid > 0 && check.hl > 0 && check.task > 0 && check.table > 0 && check.toc > 0,
    JSON.stringify(check),
  );

  // C8b 要求卡片窗格与编辑窗格同时在场，而这个布局来自前面各项积累的现场
  // （编辑窗格独立成组、保持渲染）：单独跑这一项时请直接跑全套
  // `node scripts/edit-probe.mjs`，或在 C6/C7 之后跑。
  await ev(`window.__fm.openCardPanel(${JSON.stringify(bslash(SAMPLE))}); true`);
  await sleep(1500);
  const card = JSON.parse(
    (await ev(`JSON.stringify({
      panels: window.__fm.dock.panels.length,
      cardRoot: document.querySelectorAll('.card-root').length,
      shell: document.querySelectorAll('.card-scale').length,
      editPane: document.querySelectorAll('.edit-pane').length
    })`)) ?? "{}",
  );
  record(
    "C8b",
    "卡片导出面板与编辑面板共存（三态面板互不干扰）",
    card.panels >= 3 && card.cardRoot > 0 && card.editPane > 0,
    `面板数 ${card.panels}；.card-root ${card.cardRoot}；.card-scale ${card.shell}；.edit-pane ${card.editPane}`,
  );
}

/* ================= C9：原子性（保存中强杀进程，最后执行） ================= */

if (shouldRun("C9")) {
  // 单独跑 C9 时编辑面板可能还没开（C1 才会开），这里补齐场景
  await openEditPanel(BIG);
  await activate(BIG);
  await ev(`(async () => { await ${probe(BIG)}.sync(); })()`);
  const beforeFacts = fileFacts(BIG);
  const lenBeforeInsert = await ev(`${probe(BIG)}.text().length`);
  await ev(`${probe(BIG)}.insertAtStart('原子性测试标记 ABC' + String.fromCharCode(10, 10)); true`);
  await sleep(300);
  await ev(`(async () => { await ${probe(BIG)}.sync(); })()`);
  const lenAfterInsert = await ev(`${probe(BIG)}.text().length`);
  const newHash = await ev(`(async () => window.__sha(${probe(BIG)}.text()))()`);

  ev(`(async () => { ${probe(BIG)}.save(); })()`).catch(() => {});
  await sleep(4);
  // 强杀：用进程是否还在来判断成败（taskkill 的中文/英文回显不稳定）
  try {
    execSync("taskkill /F /IM freemdown.exe", { stdio: "pipe" });
  } catch {
    /* 进程已退出时 taskkill 报错，忽略 */
  }
  await sleep(300);
  let killed = false;
  try {
    const list = execSync("tasklist /FI \"IMAGENAME eq freemdown.exe\" /FO CSV /NH", {
      stdio: "pipe",
    }).toString();
    killed = !/freemdown\.exe/i.test(list);
  } catch {
    killed = true;
  }
  await sleep(500);
  const afterFacts = fileFacts(BIG);
  const isOld = afterFacts.normHash === beforeFacts.normHash;
  const isNew = afterFacts.normHash === newHash;
  const leftovers = tmpLeftovers(BIG);
  record(
    "C9",
    "保存过程中强杀进程：磁盘只能是旧内容或新内容的完整文件（无半截文件）",
    killed && (isOld || isNew) && afterFacts.bytes > 2_000_000,
    `已杀进程 ${killed}；文件 ${afterFacts.bytes} B；= 旧内容 ${isOld}；= 新内容 ${isNew}；插入前/后缓冲 ${lenBeforeInsert}/${lenAfterInsert} 字符；残留临时文件 ${leftovers.length} 个${leftovers.length ? `（${leftovers.join(", ")}，下次保存自动清理）` : ""}`,
  );
}

/* ---------------- 汇总 ---------------- */

console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
if (consoleErrors.length) {
  console.log("控制台错误（去重前 10 条）：");
  for (const e of [...new Set(consoleErrors)].slice(0, 10)) console.log("  -", e);
}
try {
  await client.close();
} catch {
  /* 进程已被杀：连接自然断开 */
}
process.exit(fail === 0 ? 0 : 1);
