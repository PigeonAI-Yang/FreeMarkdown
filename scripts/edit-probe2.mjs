// 编辑功能 阶段 2 验收探针：块级局部替换 / 双向联动与跳转 / 大文档只重解析受影响块 / 增强降级 / 外部改动监听。
//
// 前置：应用带 CDP 启动（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223），vite（1420）存活。
//   node scripts/edit-probe2.mjs            跑全部检查
//   node scripts/edit-probe2.mjs S2 S4      只跑指定项
//
// 口径来自 docs/编辑功能方案.md 阶段 2 验收表；每项打印原始测量值。
import CDP from "chrome-remote-interface";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9223);
const ROOT = "J:/PigeonYang/FreeMarkdown";
const OUT = join(ROOT, "testdata", "out");
const ONE_MB = join(ROOT, "testdata", "big", "one-mb.md");
// 验收样例以仓库里的那份为源，运行前拷到 out/ 再编辑：探针会真实键入并自动保存，
// 直接改仓库夹具会把测试痕迹留在受版本控制的文件里。
const SAMPLE = join(OUT, "验收样例.md");
mkdirSync(OUT, { recursive: true });
copyFileSync(join(ROOT, "testdata", "验收样例.md"), SAMPLE);
const WATCH_FIX = join(OUT, "edit-watch2.md");

const only = process.argv.slice(2).filter((a) => /^S\d/.test(a));
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

mkdirSync(OUT, { recursive: true });

console.log("=== 编辑功能 阶段 2 验收 ===");
console.log(`1MB 夹具：${ONE_MB}${existsSync(ONE_MB) ? "" : "（缺失）"}\n`);

const client = await CDP({ port, wait: true });
const { Runtime, Input, Log } = client;
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
  // dev 期前端模块热更新会整页 reload，长轮询可能横跨 reload：
  // 这类"执行上下文被销毁"重试一次即可，不算被测行为失败。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await Runtime.evaluate({
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(
          r.exceptionDetails.exception?.description ??
            r.exceptionDetails.text ??
            "eval failed",
        );
      }
      return r.result.value;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (attempt === 0 && /Execution context was destroyed|Cannot find context/i.test(msg)) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

const bslash = (p) => p.replace(/\//g, "\\");
const probe = (p) => `window.__fmEdit.get(${JSON.stringify(bslash(p))})`;

/* ---------------- 场景工具 ---------------- */

async function openEdit(path, timeoutMs = 20000) {
  return ev(`(async () => {
    const p = ${JSON.stringify(path)};
    const api = window.__fm.dock;
    for (const q of [...api.panels]) {
      if (q.id.startsWith('edit:') && q.params?.path !== p) { try { q.api.close(); } catch {} await new Promise(r => setTimeout(r, 60)); }
    }
    const old = api.getPanel('edit:' + p);
    if (old) { old.api.close(); await new Promise(r => setTimeout(r, 350)); }
    window.__fm.openEditPanel(p);
    for (let i = 0; i < ${Math.ceil(timeoutMs / 40)}; i++) {
      await new Promise(r => setTimeout(r, 40));
      const h = window.__fmEdit?.get?.(p);
      const root = Array.from(document.querySelectorAll('.edit-pane')).find(e => e.dataset.editPath === p);
      if (h && root && root.querySelector('.cm-editor') && h.snapshot().metrics.parseMs.length > 0) return { ok: true };
    }
    return { ok: false };
  })()`);
}

async function focusEditor(path) {
  return ev(`(() => {
    const root = Array.from(document.querySelectorAll('.edit-pane')).find(e => e.dataset.editPath === ${JSON.stringify(bslash(path))});
    const el = root ? root.querySelector('.edit-editor .cm-content') : null;
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
}

async function probeOf(path) {
  return JSON.parse((await ev(`JSON.stringify(${probe(path)}.syncProbe())`)) ?? "null");
}

function verdict(m, tag, extra = "") {
  const d = Math.abs(m.previewTopBlock - m.editorTopBlock);
  const visible =
    m.previewTopLine != null &&
    m.previewTopLine >= m.editorTopLine &&
    m.previewTopLine <= m.editorBottomLine;
  const ok = d <= 1 || visible;
  return {
    ok,
    text: `${tag}: 编辑器顶行 ${m.editorTopLine}..${m.editorBottomLine}，预览顶行 ${m.previewTopLine}，块下标 编辑器=${m.editorTopBlock} 预览=${m.previewTopBlock}，Δ=${d}${d <= 1 ? "（对齐，≤1 块）" : visible ? "（目标在可视区内：到文档边界被滚动夹取）" : "（超出容差）"}${extra}`,
  };
}

/* ================= S1：块级局部替换（未受影响块元素身份不变） ================= */

if (shouldRun("S1")) {
  try {
  await openEdit(SAMPLE);
  await focusEditor(SAMPLE);
  // 把视口放到文档中段，并对准 mermaid 块之前的那个段落
  const plan = JSON.parse(
    await ev(`(() => {
      const h = ${probe(SAMPLE)};
      const lines = h.blockLines();
      const mid = Math.floor(lines.length / 2);
      h.gotoLine(lines[mid].start);
      return JSON.stringify({ mid, target: lines[mid], prev: lines[mid - 1] });
    })()`),
  );
  await sleep(700);
  // 记录当前挂载块的元素引用（对象身份）
  const before = JSON.parse(
    await ev(`JSON.stringify(Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).map(el => { const i = Number(el.dataset.block); return { i, rev: el.dataset.rev, start: el.dataset.start, html: el.innerHTML }; }))`),
  );
  const storedBefore = await ev(`(() => {
    window.__identity = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).map(el => ({ node: el, rev: el.dataset.rev, start: el.dataset.start, html: el.innerHTML }));
    return window.__identity.length;
  })()`);
  // 在中间那块行尾插入纯文本（不增删行 → 块数不变，便于对齐身份）
  await ev(`${probe(SAMPLE)}.insertAtLine(${plan.target.start}, ' XZQ'); true`);
  await sleep(900);
  const cmp = JSON.parse(
    await ev(`(() => {
      const before = window.__identity || [];
      const after = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]'));
      const byRev = new Map(after.map(el => [el.dataset.rev, el]));
      let sameNode = 0, rewritten = 0, lost = 0, replaced = 0, disconnected = 0;
      for (const b of before) {
        const el = byRev.get(b.rev);
        if (!el) { lost++; continue; }
        if (!el.isConnected) disconnected++;
        if (el === b.node) { sameNode++; if (el.innerHTML !== b.html) rewritten++; }
        else replaced++;
      }
      const changed = after.filter(el => el.innerHTML.includes('XZQ')).length;
      return JSON.stringify({ totalBefore: before.length, totalAfter: after.length, sameNode, replaced, lost, disconnected, rewritten, changedBlocks: changed });
    })()`),
  );
  const identityOk =
    cmp.totalBefore > 3 &&
    cmp.disconnected === 0 &&
    cmp.rewritten === 0 &&
    cmp.changedBlocks >= 1 &&
    cmp.lost <= 3 &&
    cmp.sameNode >= cmp.totalBefore - 3;
  record(
    "S1",
    "键入后未受影响的块元素身份不变（对象引用对比），受影响的块才被替换",
    identityOk,
    `挂载块 ${cmp.totalBefore} → ${cmp.totalAfter}；同一节点 ${cmp.sameNode}（其中被重写 ${cmp.rewritten}）、换节点 ${cmp.replaced}、卸载 ${cmp.lost}、脱离文档 ${cmp.disconnected}；含新内容的块 ${cmp.changedBlocks} 个（改动落在第 ${plan.target.start} 行所属块）`,
  );
  } catch (e) {
    record("S1", "（本段执行异常，见 detail）", false, String(e?.message ?? e).slice(0, 240));
  }
}


/* ================= S2：双向联动 + 双向跳转（误差 ≤1 块） ================= */

if (shouldRun("S2")) {
  try {
  /* 四个方向用 1MB 夹具：验收样例只有约 130 行，从 45% 起步已经贴住编辑器底部，
     向下滚轮完全不动（"被驱动侧没动"其实是被驱动方没得动）。
     1MB / 2.6 万行的文档四个方向都有充足余量，也顺带覆盖窗口化预览的联动。 */
  await openEdit(ONE_MB);
  await focusEditor(ONE_MB);
  const G = JSON.parse(
    await ev(`JSON.stringify({ editor: (() => { const r = document.querySelector('.edit-editor .cm-scroller')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } : null; })(), preview: (() => { const r = document.querySelector('[data-edit-preview]')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } : null; })() })`),
  );
  // 先把预览放到中段
  await ev(`(() => { const sc = document.querySelector('[data-edit-preview]'); sc.scrollTop = sc.scrollHeight * 0.3; return true; })()`);
  await sleep(800);

  const steps = [];
  const atClamp = (m, side, deltaY) => {
    const top = side === "editor" ? m.editorScrollTop : m.previewScrollTop;
    const height = side === "editor" ? m.editorScrollHeight : m.previewScrollHeight;
    const client = side === "editor" ? m.editorClientHeight : m.previewClientHeight;
    const max = Math.max(0, height - client);
    return deltaY < 0 ? top <= 2 : top >= max - 2;
  };
  const step = async (tag, side, deltaY, times) => {
    const before = await probeOf(ONE_MB);
    for (let i = 0; i < times; i++) {
      await Input.dispatchMouseEvent({
        type: "mouseWheel",
        x: side === "editor" ? G.editor.x : G.preview.x,
        y: side === "editor" ? G.editor.y : G.preview.y,
        deltaX: 0,
        deltaY,
      });
      await sleep(140);
    }
    // FM_TRACE=1：联动过程逐帧采样（排查"对齐了但被驱动侧没动"这类判定用）
    if (process.env.FM_TRACE) {
      const t0 = Date.now();
      for (let i = 0; i < 24; i++) {
        const m = await probeOf(ONE_MB);
        console.log(
          `      [trace ${String(Date.now() - t0).padStart(4)}ms] ` +
            `eTop=${m.editorTopLine} eScroll=${m.editorScrollTop}/${m.editorScrollHeight - m.editorClientHeight} ` +
            `pTop=${m.previewTopLine} pScroll=${m.previewScrollTop}/${m.previewScrollHeight - m.previewClientHeight} ` +
            `eBlk=${m.editorTopBlock} pBlk=${m.previewTopBlock} ${tag}`,
        );
        await sleep(60);
      }
    }
    await sleep(750);
    const after = await probeOf(ONE_MB);
    const v = verdict(after, tag);
    // 该动的另一侧要么真的动了，要么本来就已经滚到该方向的尽头（夹取，无从再动）
    const drivenSide = side === "editor" ? "preview" : "editor";
    const moved =
      drivenSide === "preview"
        ? after.previewScrollTop !== before.previewScrollTop
        : after.editorScrollTop !== before.editorScrollTop;
    const clamped = atClamp(before, drivenSide, deltaY) && atClamp(after, drivenSide, deltaY);
    const drv = drivenSide === "preview"
      ? `${before.previewScrollTop}→${after.previewScrollTop}px（顶块 ${before.previewTopBlock}→${after.previewTopBlock}）`
      : `${before.editorScrollTop}→${after.editorScrollTop}px（顶块 ${before.editorTopBlock}→${after.editorTopBlock}）`;
    return {
      ok: v.ok && (moved || clamped),
      text: `${v.text}；被驱动侧（${drivenSide === "preview" ? "预览" : "编辑器"}）位移 ${moved ? "有" : "无"} ${drv}${clamped ? "（已在该方向尽头，夹取）" : ""}`,
    };
  };

  // 起始场景：让两侧都停在中段——先用编辑器跳行（它的滚动会驱动预览跟上）
  await ev(`(() => {
    const h = ${probe(ONE_MB)};
    const lines = h.blockLines();
    h.gotoLine(lines[Math.floor(lines.length * 0.45)].start);
    return true;
  })()`);
  await sleep(1400);

  steps.push(await step("①编辑器↓→预览", "editor", 420, 4));
  steps.push(await step("②预览↑→编辑器", "preview", -420, 4));
  steps.push(await step("③编辑器↑→预览", "editor", -420, 3));
  steps.push(await step("④预览↓→编辑器", "preview", 420, 3));

  /* ⑤⑥ 点击跳转换小夹具：短块的文档才能保证视口内有完整可见的块可点 */
  await openEdit(SAMPLE);
  await focusEditor(SAMPLE);
  await sleep(600);

  // ⑤ 点击预览块 → 光标跳到该块起始行
  const target = JSON.parse(
    await ev(`(() => {
      const sc = document.querySelector('[data-edit-preview]').getBoundingClientRect();
      const els = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.top > sc.top + 40 && r.bottom < sc.bottom - 40;
      });
      const el = els[Math.floor(els.length / 2)];
      if (!el) return 'null';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + 12), start: Number(el.dataset.start) });
    })()`),
  );
  let clickErr = null;
  if (target) {
    await Input.dispatchMouseEvent({ type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1, buttons: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(700);
    const cur = JSON.parse((await ev(`JSON.stringify(${probe(SAMPLE)}.cursor())`)) ?? "null");
    clickErr = Math.abs(cur.line - target.start);
  }

  // ⑥ 点击编辑器 → 预览滚到对应块
  const edClick = JSON.parse(
    await ev(`(() => {
      const lines = document.querySelectorAll('.edit-editor .cm-line');
      const el = lines[Math.min(8, lines.length - 1)];
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 50), y: Math.round(r.top + 8) });
    })()`),
  );
  await Input.dispatchMouseEvent({ type: "mousePressed", x: edClick.x, y: edClick.y, button: "left", clickCount: 1, buttons: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: edClick.x, y: edClick.y, button: "left", clickCount: 1, buttons: 0 });
  await sleep(800);
  const afterEdClick = await probeOf(SAMPLE);
  const caret = JSON.parse((await ev(`JSON.stringify(${probe(SAMPLE)}.cursor())`)) ?? "null");
  const caretBlock = afterEdClick.editorTopBlock >= 0 ? afterEdClick.editorTopBlock : -1;
  const clickBlockErr = Math.abs(afterEdClick.previewTopBlock - caretBlock);

  const allOk = steps.every((s) => s.ok) && clickErr != null && clickErr <= 1 && clickBlockErr <= 1;
  record(
    "S2a",
    "滚动双向联动：四个方向定位误差 ≤1 个块",
    steps.every((s) => s.ok),
    steps.map((s) => s.text).join("\n        "),
  );
  record(
    "S2b",
    "点击跳转：预览块 → 光标行（误差 ≤1 行）",
    clickErr != null && clickErr <= 1,
    target ? `点中块起始行 ${target.start} → 光标行 ${target.start + clickErr}（误差 ${clickErr} 行）` : "未取到可点击的块",
  );
  record(
    "S2c",
    "点击跳转：编辑器 → 预览跟随（误差 ≤1 个块）",
    clickBlockErr <= 1,
    `点击后光标行 ${caret?.line}（所在块 ${caretBlock}），预览顶块 ${afterEdClick.previewTopBlock}，Δ=${clickBlockErr}`,
  );
  void allOk;
  } catch (e) {
    record("S2", "（本段执行异常，见 detail）", false, String(e?.message ?? e).slice(0, 240));
  }
}


/* ================= S3：1MB 文档只重解析受影响块（parse_ms ≤5ms） ================= */

if (shouldRun("S3")) {
  try {
  await openEdit(ONE_MB);
  await focusEditor(ONE_MB);
  await ev(`(() => { const h = ${probe(ONE_MB)}; const lines = h.blockLines(); h.gotoLine(lines[Math.floor(lines.length / 2)].start); return true; })()`);
  await sleep(600);
  const before = JSON.parse((await ev(`JSON.stringify(${probe(ONE_MB)}.snapshot())`)) ?? "null");
  const SAMPLES = 20;
  for (let i = 0; i < SAMPLES; i++) {
    await Input.insertText({ text: "字" });
    await sleep(240);
  }
  await sleep(600);
  const after = JSON.parse((await ev(`JSON.stringify(${probe(ONE_MB)}.snapshot())`)) ?? "null");
  const parseSlice = (after.metrics.parseMs ?? []).slice((before.metrics.parseMs ?? []).length);
  const payloads = (after.metrics.payloads ?? []).slice((before.metrics.payloads ?? []).length);
  const fullDelta = after.metrics.fullRenders - before.metrics.fullRenders;
  const maxParse = parseSlice.length ? Math.max(...parseSlice) : -1;
  const p95 = (() => {
    if (!parseSlice.length) return -1;
    const s = [...parseSlice].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  })();
  record(
    "S3",
    "1MB 文档键入：只重解析受影响块（render_blocks parse_ms ≤5ms / 次数 = 键入次数）",
    parseSlice.length >= SAMPLES - 3 && maxParse >= 0 && maxParse <= 5 && fullDelta === 0,
    `样本 ${parseSlice.length} 次切片解析：P95 ${p95}ms、最大 ${maxParse}ms（口径 ≤5ms）；整篇兜底 ${fullDelta} 次；单次载荷最大 ${payloads.length ? Math.max(...payloads) : 0} B`,
  );
  } catch (e) {
    record("S3", "（本段执行异常，见 detail）", false, String(e?.message ?? e).slice(0, 240));
  }
}


/* ================= S4：增强降级（打字期不渲染 mermaid；空闲后补齐且与整篇一致） ================= */

if (shouldRun("S4")) {
  try {
  // 专用夹具：只有 mermaid、没有脚注定义（有脚注的文档会走整篇兜底，见 S4c）
  const MERMAID_FIX = join(OUT, "edit-mermaid.md");
  const fence = "```";
  writeFileSync(
    MERMAID_FIX,
    [
      "# 图表测试",
      "",
      "第一段正文，用来承接改动。",
      "",
      `${fence}mermaid`,
      "graph LR; A[开始]-->B[结束];",
      fence,
      "",
      "尾段正文。",
      "",
    ].join("\n"),
    "utf8",
  );

  // 阅读面板同开，用于对比同一张图的渲染结果
  await ev(`window.__fm.openFile(${JSON.stringify(bslash(MERMAID_FIX))}); true`);
  await sleep(700);
  await ev(`(async () => { const d = window.__fm.dock.getPanel('doc:' + ${JSON.stringify(bslash(MERMAID_FIX))}); if (d) { d.api.setActive(); d.group.api.setActive(); } await new Promise(r => setTimeout(r, 300)); return true; })()`);
  await sleep(1600);
  await openEdit(MERMAID_FIX);
  await focusEditor(MERMAID_FIX);

  const mm = JSON.parse(
    await ev(`(() => {
      const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => e.querySelector('pre code.language-mermaid') || e.querySelector('.mermaid-host'));
      if (!el) return 'null';
      return JSON.stringify({ start: Number(el.dataset.start), end: Number(el.dataset.end) });
    })()`),
  );
  const rendered0 = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => Number(e.dataset.start) === ${mm ? mm.start : 0});
    if (!el) return 'no-block';
    return el.querySelector('.mermaid-host svg') ? 'svg' : (el.querySelector('pre code.language-mermaid') ? 'raw' : 'other');
  })()`);
  if (rendered0 !== "svg") {
    await sleep(1500); // 首次渲染可能还在路上
  }
  const rendered1 = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => Number(e.dataset.start) === ${mm ? mm.start : 0});
    if (!el) return 'no-block';
    return el.querySelector('.mermaid-host svg') ? 'svg' : (el.querySelector('pre code.language-mermaid') ? 'raw' : 'other');
  })()`);

  // 在 mermaid 块的上一块行尾插空格 → ±1 块的切片重渲染会重挂 mermaid 块
  const prevEnd = Number(
    await ev(`(() => {
      const lines = ${probe(MERMAID_FIX)}.blockLines();
      const i = lines.findIndex(b => b.start === ${mm ? mm.start : 0});
      return i > 0 ? lines[i - 1].end : 1;
    })()`),
  );
  const revBefore = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => Number(e.dataset.start) === ${mm ? mm.start : 0});
    return el ? el.dataset.rev : null;
  })()`);
  await ev(`${probe(MERMAID_FIX)}.insertAtLine(${prevEnd}, ' '); true`);
  await ev(`(async () => { await ${probe(MERMAID_FIX)}.sync(); })()`);
  const duringTyping = JSON.parse(
    await ev(`(() => {
      const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => Number(e.dataset.start) === ${mm ? mm.start : 0});
      if (!el) return JSON.stringify({ kind: 'no-block' });
      const h = ${probe(MERMAID_FIX)};
      return JSON.stringify({ kind: el.querySelector('.mermaid-host svg') ? 'svg' : (el.querySelector('pre code.language-mermaid') ? 'raw' : 'other'), rev: el.dataset.rev, full: h.snapshot().metrics.fullRenders });
    })()`),
  );
  await sleep(2200);
  const afterIdle = JSON.parse(
    await ev(`(() => {
      const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => Number(e.dataset.start) === ${mm ? mm.start : 0});
      if (!el) return JSON.stringify({ kind: 'no-block' });
      const svg = el.querySelector('.mermaid-host svg');
      return JSON.stringify({ kind: svg ? 'svg' : (el.querySelector('pre code.language-mermaid') ? 'raw' : 'other'), rev: el.dataset.rev, viewBox: svg ? svg.getAttribute('viewBox') : null });
    })()`),
  );
  const readerVb = await ev(`(() => {
    const svg = document.querySelector('.doc-content .mermaid-host svg');
    return svg ? svg.getAttribute('viewBox') : null;
  })()`);
  record(
    "S4a",
    "打字期间不触发 mermaid 重渲染（块被重挂但保持源码态）",
    rendered1 === "svg" && duringTyping.kind === "raw" && duringTyping.rev !== revBefore,
    `改动前 ${rendered1}（已渲染，rev=${revBefore}）→ 同步后 ${duringTyping.kind}（raw=源码态，rev=${duringTyping.rev}：块确实被重挂过）；整篇兜底次数 ${duringTyping.full}`,
  );
  record(
    "S4b",
    "空闲后补齐渲染，结果与整篇渲染一致（viewBox 相同）",
    afterIdle.kind === "svg" && !!afterIdle.viewBox && afterIdle.viewBox === readerVb,
    `空闲后 ${afterIdle.kind}（rev=${afterIdle.rev}）；预览 viewBox=${afterIdle.viewBox}；阅读面板同一张图 viewBox=${readerVb}`,
  );

  // S4c：含脚注定义的文档走整篇兜底（脚注编号依赖全文顺序，切片会失真）
  await openEdit(SAMPLE);
  await focusEditor(SAMPLE);
  const full0 = JSON.parse((await ev(`JSON.stringify(${probe(SAMPLE)}.snapshot())`)) ?? "null");
  await ev(`${probe(SAMPLE)}.insertAtLine(2, ' '); true`);
  await ev(`(async () => { await ${probe(SAMPLE)}.sync(); })()`);
  await sleep(600);
  const full1 = JSON.parse((await ev(`JSON.stringify(${probe(SAMPLE)}.snapshot())`)) ?? "null");
  const footnoteOk = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('[data-edit-preview] [data-block]')).find(e => (e.innerHTML || '').includes('footnote'));
    return !!el;
  })()`);
  record(
    "S4c",
    "含脚注定义的文档走整篇兜底（编号依赖全文顺序，宁可多解析不可渲染错）",
    full1.metrics.fullRenders > full0.metrics.fullRenders && full1.metrics.splices === full0.metrics.splices && footnoteOk,
    `整篇兜底 ${full0.metrics.fullRenders} → ${full1.metrics.fullRenders} 次；切片次数不变（${full0.metrics.splices} → ${full1.metrics.splices}）；脚注区块仍在预览中 ${footnoteOk}`,
  );
  } catch (e) {
    record("S4", "（本段执行异常，见 detail）", false, String(e?.message ?? e).slice(0, 240));
  }
}


/* ================= S5：外部改动监听（notify） ================= */

if (shouldRun("S5")) {
  try {
  writeFileSync(WATCH_FIX, "# 监听测试\n\n初始内容 A1\n", "utf8");
  await ev(`window.__fm.openFile(${JSON.stringify(bslash(WATCH_FIX))}); true`);
  await sleep(700);
  await ev(`(async () => { const d = window.__fm.dock.getPanel('doc:' + ${JSON.stringify(bslash(WATCH_FIX))}); if (d) { d.api.setActive(); d.group.api.setActive(); } await new Promise(r => setTimeout(r, 300)); return true; })()`);
  await sleep(900);
  const readerText = () =>
    ev(`(() => { const el = Array.from(document.querySelectorAll('.doc-content')).find(e => e.dataset.path === ${JSON.stringify(bslash(WATCH_FIX))}); return el ? el.innerText.slice(0, 20) : null; })()`);
  const t0 = await readerText();
  const counts = await ev(`(async () => JSON.stringify(await window.__fmIpc.watchCount()))()`);
  writeFileSync(WATCH_FIX, "# 监听测试\n\n外部改动 B2\n", "utf8");
  await sleep(1600);
  const t1 = await readerText();
  record(
    "S5a",
    "阅读面板：外部改动后自动热刷新（mtime 变了才刷）",
    typeof t0 === "string" && typeof t1 === "string" && t1.includes("外部改动 B2"),
    `刷新前 ${JSON.stringify(String(t0))} → 刷新后 ${JSON.stringify(String(t1))}；Rust 侧监听集合 (文件, 目录) = ${counts}`,
  );

  await openEdit(WATCH_FIX);
  await focusEditor(WATCH_FIX);
  await ev(`${probe(WATCH_FIX)}.insertAtStart('本地改动 C3' + String.fromCharCode(10, 10)); true`);
  await sleep(300);
  writeFileSync(WATCH_FIX, "# 监听测试\n\n外部改动 D4\n", "utf8");
  await sleep(2000);
  const st = JSON.parse((await ev(`JSON.stringify(${probe(WATCH_FIX)}.snapshot())`)) ?? "null");
  const ui = JSON.parse((await ev(`JSON.stringify(${probe(WATCH_FIX)}.conflictUi())`)) ?? "null");
  const disk = readFileSync(WATCH_FIX, "utf8");
  record(
    "S5b",
    "编辑面板：外部改动时主动提示冲突（不等下一次保存），不静默覆盖",
    st?.conflict != null && ui?.visible === true && disk.includes("外部改动 D4"),
    `冲突 mtime ${st?.conflict}；横幅可见 ${ui?.visible}，按钮 [${ui?.buttons?.join(" / ")}]；磁盘仍是外部内容 ${disk.includes("外部改动 D4")}`,
  );

  // 自己保存引起的事件不该被当成外部改动
  await ev(`${probe(WATCH_FIX)}.clickConflict('覆盖'); true`);
  await sleep(900);
  const after = JSON.parse((await ev(`JSON.stringify(${probe(WATCH_FIX)}.snapshot())`)) ?? "null");
  record(
    "S5c",
    "自己保存触发的事件不会误判成外部冲突",
    after?.conflict == null && after?.dirty === false,
    `覆盖后 冲突 ${after?.conflict}、dirty ${after?.dirty}`,
  );
  } catch (e) {
    record("S5", "（本段执行异常，见 detail）", false, String(e?.message ?? e).slice(0, 240));
  }
}


/* ---------------- 汇总 ---------------- */

console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
if (consoleErrors.length) {
  console.log("控制台错误（去重前 8 条）：");
  for (const e of [...new Set(consoleErrors)].slice(0, 8)) console.log("  -", e);
}
console.log(JSON.stringify({ pass, fail, results }, null, 1));
try {
  await client.close();
} catch {
  /* ignore */
}
process.exit(fail === 0 ? 0 : 1);
