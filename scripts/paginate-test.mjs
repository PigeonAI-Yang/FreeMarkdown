/**
 * paginate-core 纯逻辑直测（零 DOM）。
 * 运行：node --experimental-strip-types scripts/paginate-test.mjs
 * 全部 PASS 退出码 0；任一 FAIL 退出码 1。
 */
import assert from "node:assert/strict";
import { computeCuts, flattenUnits } from "../src/card/engine/paginate-core.ts";

let failed = 0;
function run(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message}`);
  }
}

// —— 便捷构造器 ——
const para = (top, height) => ({ top, height, kind: "para", level: 0 });
const heading = (top, height, level = 2) => ({ top, height, kind: "heading", level });
const atomicNode = (top, height) => ({ top, height, kind: "atomic", level: 0 });
const list = (top, height, children) => ({ top, height, kind: "list", level: 0, children });
const quote = (top, height, children) => ({ top, height, kind: "quote", level: 0, children });

/** 把结果压成 [top, height] 便于断言 */
const flat = (cuts) => cuts.map((c) => [c.top, c.height]);

/**
 * 通用不变量：
 * 1) 首卡从首块顶部开始，末卡覆盖到最后一块底部；
 * 2) 相邻 CardCut 首尾衔接（连续覆盖，无空洞无重叠）；
 * 3) 超预算卡必是某个超大块（顶层或 children 内）独占卡，高度恰为该块实际高度；
 * 4) start/end 区间连续无缝覆盖全部 units，且与 top/height 几何一致
 *    （首单元不高于卡顶、末单元不超卡底、卡底边界落在下一单元顶之前的空隙内）。
 */
function checkCommon(nodes, budget, cuts) {
  assert.ok(cuts.length >= 1, "应至少产出一张卡");
  assert.equal(cuts[0].top, nodes[0].top, "首卡应从首块顶部开始");
  const last = nodes[nodes.length - 1];
  const end = cuts[cuts.length - 1];
  assert.equal(end.top + end.height, last.top + last.height, "末卡应覆盖到最后一块底部");
  for (let i = 1; i < cuts.length; i++) {
    assert.equal(
      cuts[i].top,
      cuts[i - 1].top + cuts[i - 1].height,
      `第 ${i} 卡应与前一卡首尾衔接`,
    );
  }
  for (const c of cuts) {
    if (c.height > budget) {
      const hit =
        nodes.some((n) => n.height === c.height && n.height > budget) ||
        nodes.some((n) => (n.children ?? []).some((k) => k.height === c.height && k.height > budget));
      assert.ok(hit, `超预算卡高度 ${c.height} 应对应某个超大块的独占卡`);
    } else {
      assert.ok(c.height <= budget, `非独占卡高度 ${c.height} 不应超过 budget ${budget}`);
    }
  }
  // —— start/end 区间不变量 ——
  const units = flattenUnits(nodes);
  assert.equal(cuts[0].start, 0, "首卡应从 unit 0 开始");
  assert.equal(end.end, units.length - 1, "末卡应覆盖到最后一个 unit");
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    assert.ok(c.start <= c.end, `第 ${i} 卡区间非空`);
    if (i > 0) {
      assert.equal(c.start, cuts[i - 1].end + 1, `第 ${i} 卡 start 应与前一卡 end 无缝衔接`);
      assert.ok(
        units[c.start].top >= cuts[i - 1].top + cuts[i - 1].height - 1e-6,
        `第 ${i} 卡切界不穿过首单元`,
      );
    }
    const first = units[c.start];
    const spanBottom = units[c.end].top + units[c.end].height;
    assert.ok(first.top >= c.top, `第 ${i} 卡首单元不高于卡顶`);
    assert.ok(spanBottom <= c.top + c.height + 1e-6, `第 ${i} 卡末单元不超卡底`);
    const next = units[c.end + 1];
    if (next) {
      assert.ok(
        c.top + c.height <= next.top + 1e-6,
        `第 ${i} 卡底边界应落在下一单元顶之前的空隙内`,
      );
    }
  }
}

// 1. 常规多块装填：贪心累计，块边界切卡
run("常规多块装填", () => {
  const nodes = [0, 60, 120, 180, 240].map((t) => para(t, 60));
  const cuts = computeCuts(nodes, 150);
  checkCommon(nodes, 150, cuts);
  assert.deepEqual(flat(cuts), [[0, 120], [120, 120], [240, 60]]);
});

// 2. 标题不孤行：卡尾 heading 挪到下一卡与下一块同卡
run("标题孤行挪卡", () => {
  const nodes = [para(0, 80), heading(80, 20), para(100, 40)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 80], [80, 60]]); // 第二卡 = 标题 + 段落
});

// 3. 极端：标题 + 下一块仍超 budget → 「标题 + 0 块」独立成卡
run("标题加零块极端成卡", () => {
  const nodes = [para(0, 85), heading(85, 15), para(100, 90)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 85], [85, 15], [100, 90]]); // 中卡只有标题
});

// 4. 超大 atomic（pre/img/table/hr/mermaid）独占一卡，height 用实际高度
run("超大pre独占一卡", () => {
  const nodes = [para(0, 50), atomicNode(50, 300), para(350, 50)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 50], [50, 300], [350, 50]]);
  assert.ok(cuts[1].height > 100, "独占卡允许超预算");
});

// 5. 长 list 单块超 budget → 降级用 children（li）二次切分
run("长list经children切分", () => {
  const nodes = [list(0, 240, [para(0, 60), para(60, 60), para(120, 60), para(180, 60)])];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 60], [60, 60], [120, 60], [180, 60]]);
});

// 5b. children 内单个超预算项按 atomic 独占一卡（不再递归）
run("list子项超预算按atomic独占", () => {
  const nodes = [list(0, 300, [para(0, 150), para(150, 150)])];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 150], [150, 150]]);
});

// 6. 长 quote 切分：引用内直接子块作为切分点
run("长quote切分", () => {
  const nodes = [quote(0, 220, [para(0, 100), para(100, 120)])];
  const cuts = computeCuts(nodes, 150);
  checkCommon(nodes, 150, cuts);
  assert.deepEqual(flat(cuts), [[0, 100], [100, 120]]);
});

// 6b. quote 内含标题：孤行规则同样作用于引用内子块
run("quote内标题孤行挪卡", () => {
  const nodes = [
    quote(0, 260, [para(0, 80), heading(80, 20), para(100, 100), para(200, 60)]),
  ];
  const cuts = computeCuts(nodes, 120);
  checkCommon(nodes, 120, cuts);
  assert.deepEqual(flat(cuts), [[0, 80], [80, 120], [200, 60]]); // 第二卡以标题开头
});

// 7. 空输入 / budget 非法 → 空数组
run("空输入与非法budget", () => {
  assert.deepEqual(computeCuts([], 100), []);
  assert.deepEqual(computeCuts([para(0, 50)], 0), []);
  assert.deepEqual(computeCuts([para(0, 50)], -5), []);
});

// 8. budget 极小：所有块都超预算且无 children → 逐块独占
run("budget极小逐块独占", () => {
  const nodes = [para(0, 30), para(30, 30)];
  const cuts = computeCuts(nodes, 10);
  checkCommon(nodes, 10, cuts);
  assert.deepEqual(flat(cuts), [[0, 30], [30, 30]]);
});

// 9. 连续多个标题：标题串整体不与下一块同卡时，「标题 + 0 块」成卡
run("连续多个标题串独立成卡", () => {
  const nodes = [heading(0, 20, 1), heading(20, 20, 2), para(40, 90), para(130, 50)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 40], [40, 90], [130, 50]]); // 首卡只有两个标题
});

// 9b. 连续多个标题 + 下一块放得下 → 标题串与下一块同卡
run("连续多个标题随下一块装填", () => {
  const nodes = [heading(0, 20), heading(20, 20), para(40, 50), para(90, 80)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 90], [90, 80]]); // 首卡含两个标题 + 段落
});

// 10. 标题后紧跟超大独占块：标题独立成卡，独占卡高度不受影响
run("标题后接独占块", () => {
  const nodes = [para(0, 40), heading(40, 20), atomicNode(60, 200)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 40], [40, 20], [60, 200]]);
});

// 11. 文档末卡以标题结尾是合法的（后面没有内容可孤行）
run("末卡以标题结尾合法", () => {
  const nodes = [para(0, 50), heading(50, 20)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 70]]);
});

// 12. 整文档不超过 budget → 单卡
run("整文档单卡", () => {
  const nodes = [para(0, 50), para(50, 50)];
  const cuts = computeCuts(nodes, 100);
  checkCommon(nodes, 100, cuts);
  assert.deepEqual(flat(cuts), [[0, 100]]);
});

// 13. list 首末 li 与父块之间的留白归一化：覆盖不丢 [父顶, 父底]
run("list留白归一化覆盖", () => {
  const nodes = [list(0, 240, [para(10, 50), para(60, 60), para(120, 110)])];
  const cuts = computeCuts(nodes, 130);
  checkCommon(nodes, 130, cuts); // 覆盖 [0, 240]，含 ul 顶/底留白
  assert.deepEqual(flat(cuts), [[0, 120], [120, 120]]);
});

// 14. 恰好等于 budget 的装填不切卡（<= 判定）
run("恰好等于budget不切卡", () => {
  const nodes = [para(0, 50), para(50, 50)];
  const cuts = computeCuts(nodes, 100);
  assert.equal(cuts.length, 1);
});

// 15. flattenUnits：list/quote 展开为 children 并带 parent 标记，顶层块原样透传
run("flattenUnits展开与parent标记", () => {
  const nodes = [
    para(0, 50),
    list(50, 120, [para(50, 60), para(110, 60)]),
    quote(170, 80, [para(170, 80)]),
    para(250, 40),
  ];
  const units = flattenUnits(nodes);
  assert.equal(units.length, 5);
  assert.equal(units[0].parent, undefined, "顶层块无 parent 标记");
  assert.equal(units[1].parent, "list", "list 的 li 标记 list");
  assert.equal(units[2].parent, "list");
  assert.equal(units[3].parent, "quote", "quote 内块标记 quote");
  assert.equal(units[4].parent, undefined);
  // 展开后仍精确覆盖 [首块顶, 末块底]（留白归一化）
  assert.equal(units[1].top, 50, "list 顶部无留白时首子块顶 = 父块顶");
  assert.equal(
    units[4].top + units[4].height,
    nodes[3].top + nodes[3].height,
    "展开覆盖到最后一块底部",
  );
  assert.equal(units[2].top + units[2].height, units[3].top, "list 内相邻子块首尾衔接");
  // el 引用随展开透传（渲染层按它 cloneNode）
  const shaped = flattenUnits([
    { ...list(0, 60, [{ ...para(0, 30), el: "li-1" }, { ...para(30, 30), el: "li-2" }]), el: "ul" },
  ]);
  assert.equal(shaped[0].el, "li-1", "el 引用随展开透传");
  assert.equal(shaped[1].el, "li-2");
});

// 16. start/end 连续无缝覆盖：标题挪卡 + list 降级跨卡 + quote + atomic 混合场景
run("start/end连续无缝覆盖", () => {
  const nodes = [
    para(0, 50),
    heading(50, 20),
    list(70, 300, [para(70, 100), para(170, 100), para(270, 100)]),
    para(370, 60),
    quote(430, 160, [para(430, 80), para(510, 80)]),
    atomicNode(590, 250),
    para(840, 40),
  ];
  const budget = 150;
  const cuts = computeCuts(nodes, budget);
  checkCommon(nodes, budget, cuts); // 已含区间不变量
  const units = flattenUnits(nodes);
  assert.equal(cuts[0].start, 0);
  assert.equal(cuts[cuts.length - 1].end, units.length - 1);
  assert.ok(cuts.length >= 6, `混合场景应产出多卡（实际 ${cuts.length}）`);
});

// 17. 区间与 top/height 几何一致：卡底恰夹在「末单元底 ~ 下一单元顶」之间
run("区间与几何一致", () => {
  const nodes = [
    list(0, 240, [para(0, 60), para(60, 60), para(120, 60), para(180, 60)]),
    para(240, 50),
  ];
  const budget = 150;
  const cuts = computeCuts(nodes, budget);
  checkCommon(nodes, budget, cuts);
  const units = flattenUnits(nodes);
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    const spanBottom = units[c.end].top + units[c.end].height;
    assert.ok(c.top + c.height + 1e-6 >= spanBottom, `第 ${i} 卡卡底不早于末单元底`);
    const next = units[c.end + 1];
    if (next) {
      assert.ok(
        c.top + c.height <= next.top + 1e-6,
        `第 ${i} 卡卡底不晚于下一单元顶（边界落在块间空隙）`,
      );
    }
  }
  assert.deepEqual(
    cuts.map((c) => [c.start, c.end]),
    [[0, 1], [2, 3], [4, 4]],
  );
});

if (failed > 0) {
  console.log(`\n${failed} 个用例 FAIL`);
  process.exitCode = 1;
} else {
  console.log("\n全部用例 PASS");
}
