/**
 * 分页切割核心：纯函数、零 DOM 运行时依赖，可在 node 下直测
 * （node --experimental-strip-types，仅用可擦除语法：类型注解 / interface / type；
 *   el 字段只是 DOM 类型引用，由 collectNodes 填充、渲染层消费，本层不触碰）。
 *
 * 输入是 collectNodes 采集到的块几何序列（top 单调不减，内容坐标系 px），
 * 输出每张卡的内容视口范围；下游渲染层按 CardCut 渲染每张卡。
 * CardCut.top/height 语义不变；start/end 指向 flattenUnits 序列的闭区间索引，
 * 供「每卡独立小 DOM」按块克隆（CardPanel.buildCardDom），捕获根不再携带全量文档。
 */

export type PagKind = "heading" | "para" | "atomic" | "list" | "quote";

/** 单个可分页块的几何与语义信息（内容坐标系 px） */
export interface PagShape {
  top: number;
  height: number;
  kind: PagKind;
  /** heading 层级 1-6；其他块恒为 0 */
  level: number;
  /** list 的 li / blockquote 内直接子块的 shape（仅一层，供降级切分） */
  children?: PagShape[];
  /** 展开单元的来源标记：list 的 li → "list"、quote 内块 → "quote"；顶层块无此字段 */
  parent?: "list" | "quote";
  /** 原始 DOM 引用（仅类型，渲染层按它 cloneNode；纯逻辑层不读写） */
  el?: HTMLElement;
}

/** 一张卡的内容视口范围（内容坐标系 px）；
    start/end：本卡覆盖 flattenUnits(nodes) 序列的 [start, end] 闭区间索引 */
export interface CardCut {
  top: number;
  height: number;
  start: number;
  end: number;
}

/** 展开后的装填单元：atomic 块独占一卡，其余按贪心装填；index 为 flattenUnits 序号 */
interface Item {
  shape: PagShape;
  atomic: boolean;
  index: number;
}

/**
 * 把顶层块序列展开为装填单元序列（computeCuts 内部与渲染层共用，避免两份逻辑漂移）：
 * - 带 children 的块（list/quote）展开为其 children：父块顶部留白并入首子块、
 *   底部留白并入末子块，展开后仍精确覆盖 [首块顶, 末块底]；
 * - 展开单元带 parent 标记，顶层块原样透传（无 parent）；
 * - el（原始 DOM 引用）随展开原样透传。
 */
export function flattenUnits(nodes: PagShape[]): PagShape[] {
  const out: PagShape[] = [];
  for (const n of nodes) {
    const kids = n.children;
    if (!kids || kids.length === 0) {
      out.push(n);
      continue;
    }
    const parent = n.kind === "list" ? "list" : n.kind === "quote" ? "quote" : undefined;
    const parentBottom = n.top + n.height;
    for (let i = 0; i < kids.length; i++) {
      let { top, height } = kids[i];
      if (i === 0 && top > n.top) {
        height += top - n.top; // 顶部留白并入首子块
        top = n.top;
      }
      if (i === kids.length - 1) {
        height = parentBottom - top; // 底部留白并入末子块
      }
      out.push({ ...kids[i], top, height, parent });
    }
  }
  return out;
}

/** 标记装填属性：超预算块（含降级子块）按 atomic 独占一卡，其余贪心装填 */
function toItems(units: PagShape[], budget: number): Item[] {
  return units.map((shape, index) => ({ shape, atomic: shape.height > budget, index }));
}

/** 弹出卡尾连续的 heading 串（标题不孤行，需整串挪卡） */
function popTrailingHeadings(cur: Item[]): Item[] {
  const run: Item[] = [];
  while (cur.length > 0 && cur[cur.length - 1].shape.kind === "heading") {
    run.unshift(cur.pop() as Item);
  }
  return run;
}

/** 标题串的底部（最后一块的块底） */
function runBottom(run: Item[]): number {
  const s = run[run.length - 1].shape;
  return s.top + s.height;
}

/**
 * 按高度预算把块序列贪心切成多张卡。
 *
 * 算法概述（O(n)，单遍）：
 * 1. flattenUnits 展开后，按顺序累计装填（卡高以「卡顶到块底的跨度」计，
 *    块间 margin 自然计入预算）；装不下即在本块前收卡。
 * 2. 收卡边界 = min(下一块顶, 卡顶 + budget)：边界落在块间空隙内，
 *    绝不穿过单块，也保证相邻 CardCut 首尾衔接、非独占卡 height <= budget。
 * 3. 尾部 heading 串不孤行：挪到下一卡与下一块同卡；若标题串 + 下一块
 *    仍超 budget，允许「标题 + 0 块」独立成卡（极端情况）。
 * 4. atomic 块独占一卡，height 用块实际高度（允许超预算）；
 *    文档末卡以 heading 结尾是合法的（后面没有内容可孤行）。
 * 5. 每张卡同时记录覆盖的 flattenUnits 闭区间 [start, end]：
 *    全部卡首尾相接、无缝覆盖 [0, units.length - 1]。
 */
export function computeCuts(nodes: PagShape[], budget: number): CardCut[] {
  if (nodes.length === 0 || budget <= 0) return [];
  const items = toItems(flattenUnits(nodes), budget);

  const cuts: CardCut[] = [];
  let cur: Item[] = []; // 当前卡已装填的块
  let cardTop = items[0].shape.top; // 当前卡覆盖起点（= 上一卡的收卡边界）
  let curBottom = cardTop; // 当前卡已装填内容的底部

  // 收卡：top/height 语义同前；start/end 取本卡覆盖单元的闭区间索引
  const push = (top: number, height: number, covered: Item[]): void => {
    cuts.push({
      top,
      height,
      start: covered[0].index,
      end: covered[covered.length - 1].index,
    });
  };

  // 常规收卡：bottom 夹在 budget 内（clamp 点落在块间空隙，不穿块），
  // 并把 cardTop 推进到边界，保证与下一卡首尾衔接
  const flush = (bottom: number): void => {
    if (cur.length === 0) return;
    const edge = Math.min(bottom, cardTop + budget);
    push(cardTop, edge - cardTop, cur);
    cardTop = edge;
    cur = [];
  };

  for (const it of items) {
    const s = it.shape;
    const bottom = s.top + s.height;

    if (it.atomic) {
      // —— 独占一卡：先把当前卡收尾（尾部标题串按「标题 + 0 块」独立成卡）——
      // 此处边界不 clamp（优先保证独占卡 height == 块实际高度，
      // 块前空隙并入前卡；真实排版中块间 margin 极小，极端样式才可能轻微超预算）
      if (cur.length > 0 && cur[cur.length - 1].shape.kind === "heading") {
        const run = popTrailingHeadings(cur);
        const top = run[0].shape.top;
        if (cur.length > 0) {
          push(cardTop, top - cardTop, cur);
        }
        push(top, s.top - top, run); // 标题串独立成卡（含与独占块间的空隙）
      } else if (cur.length > 0) {
        push(cardTop, s.top - cardTop, cur);
      }
      push(s.top, s.height, [it]);
      cardTop = s.top + s.height;
      curBottom = cardTop;
      cur = [];
      continue;
    }

    if (cur.length === 0) {
      // 新卡首块：展开后单块必 <= budget，直接装填
      // （卡顶保持上一卡边界——块前空隙计入本卡，实现首尾衔接）
      cur.push(it);
      curBottom = bottom;
      continue;
    }

    if (bottom - cardTop <= budget) {
      cur.push(it);
      curBottom = bottom;
      continue;
    }

    // —— 装不下：在本块前切卡 ——
    if (cur[cur.length - 1].shape.kind === "heading") {
      const run = popTrailingHeadings(cur);
      const top = run[0].shape.top;
      flush(top); // 去掉标题串后的部分先收卡（边界 = 串顶）
      if (bottom - top <= budget) {
        // 标题串挪到下一卡，与下一块同卡
        cardTop = top;
        cur = run;
        curBottom = runBottom(run);
        cur.push(it);
        curBottom = bottom;
      } else {
        // 极端：标题串 + 下一块仍超 budget → 「标题 + 0 块」独立成卡
        const edge = Math.min(s.top, top + budget);
        push(top, edge - top, run);
        cardTop = edge;
        cur = [it];
        curBottom = bottom;
      }
    } else {
      flush(s.top); // 边界夹在本块顶与预算线之间（块间空隙），不穿块
      cur = [it];
      curBottom = bottom;
    }
  }

  // 末卡收尾（允许以 heading 结尾：后面没有内容了）
  if (cur.length > 0) {
    push(cardTop, curBottom - cardTop, cur);
  }
  return cuts;
}
