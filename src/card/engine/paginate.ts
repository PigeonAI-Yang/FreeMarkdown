/**
 * DOM 采集层：把渲染完成的 markdown 容器一次性扫描为分页形状序列。
 *
 * 性能关键 —— 单次只读 reflow pass：
 * - 全程只读（offsetTop/offsetHeight/getBoundingClientRect/querySelector），
 *   绝不在读取之间做任何写操作，浏览器对整批读取最多做一次布局计算，
 *   避免「读-写-读」交替造成的 layout thrashing；
 * - 相对定位：子元素 offsetTop 相对其 offsetParent。container 是 offsetParent
 *   时直接用 offsetTop；否则以「共享 offsetParent 视口顶 - container 视口顶」
 *   一次性算出基准 base，用 offsetTop + base 换算，避免逐元素反复取 rect；
 *   offsetParent 与两者都不一致的个别元素（如 position:fixed/relative 特例）
 *   用 getBoundingClientRect 差值兜底；
 * - 共两轮读取（先顶层直接子元素，再 list/quote 的子块），均为纯读，
 *   reflow 次数有限；几何读完后才是纯计算，不再触碰 DOM。
 */

import type { PagKind, PagShape } from "./paginate-core";

export {
  computeCuts,
  flattenUnits,
  type PagShape,
  type PagKind,
  type CardCut,
} from "./paginate-core";

/** 单个元素的纵向几何（相对 container 内容坐标系） */
interface Geom {
  top: number;
  height: number;
}

/** 语义分类结果 */
interface Classified {
  kind: PagKind;
  level: number;
}

/**
 * 块语义分类（只读 tagName/class，不触发布局）：
 * - h1-h6 → heading（level 1-6）；
 * - pre/table/hr/img → atomic；
 * - ul/ol → list；blockquote → quote；
 * - 其余（p、div、dl 等）→ para，其中含 mermaid 渲染产物的 div 视为 atomic。
 */
function classify(el: HTMLElement): Classified {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return { kind: "heading", level: Number(tag.slice(1)) };
  if (tag === "PRE" || tag === "TABLE" || tag === "HR" || tag === "IMG") {
    return { kind: "atomic", level: 0 };
  }
  if (tag === "UL" || tag === "OL") return { kind: "list", level: 0 };
  if (tag === "BLOCKQUOTE") return { kind: "quote", level: 0 };
  // mermaid 容器：fenced code 渲染产物（.language-mermaid 代码块或渲染完成标记）
  if (el.querySelector(".language-mermaid, [data-mermaid-done]") !== null) {
    return { kind: "atomic", level: 0 };
  }
  return { kind: "para", level: 0 };
}

/**
 * 采集分页形状。只遍历 container 的直接子元素；
 * list/quote 额外向下采集一层子块（li / 引用内直接子块），不再深入。
 * 每个 shape 携带原始 el 引用：CardPanel 拆卡时按 CardCut.start/end
 * 只克隆本卡覆盖的块（每卡独立小 DOM），el 是克隆的源头。
 */
export function collectNodes(container: HTMLElement): PagShape[] {
  const kids = Array.from(container.children) as HTMLElement[];
  if (kids.length === 0) return [];

  // ============ 只读 pass 开始：以下不得出现任何写操作 ============
  const directOffset = kids[0].offsetParent === container;
  const containerRect = directOffset ? null : container.getBoundingClientRect();
  // 常规文档流中所有直接子元素共享同一 offsetParent（≠ container），
  // 用第一个子元素的 offsetParent 一次性求基准
  const sharedParent = directOffset ? null : (kids[0].offsetParent as HTMLElement | null);
  const base =
    sharedParent && containerRect
      ? sharedParent.getBoundingClientRect().top - containerRect.top
      : 0;

  // 单元素几何：优先 offsetTop（相对 container 或共享 offsetParent + 基准），
  // offsetParent 对不上时用 rect 差值兜底（个别定位特例，仍属只读）
  const readGeom = (el: HTMLElement): Geom => {
    const height = el.offsetHeight;
    const op = el.offsetParent;
    if (op === container) return { top: el.offsetTop, height };
    if (op !== null && sharedParent !== null && op === sharedParent) {
      return { top: el.offsetTop + base, height };
    }
    return { top: el.getBoundingClientRect().top - (containerRect as DOMRect).top, height };
  };

  // 第一轮：顶层直接子元素
  const topGeoms = kids.map(readGeom);

  // 第二轮：list → li 子块；quote → 引用内直接子块（仍为纯读）
  const childReads: { el: HTMLElement; geom: Geom }[][] = kids.map((el) => {
    if (el.tagName === "UL" || el.tagName === "OL") {
      return (Array.from(el.children) as HTMLElement[])
        .filter((c) => c.tagName === "LI")
        .map((c) => ({ el: c, geom: readGeom(c) }));
    }
    if (el.tagName === "BLOCKQUOTE") {
      return (Array.from(el.children) as HTMLElement[]).map((c) => ({ el: c, geom: readGeom(c) }));
    }
    return [];
  });
  // ============ 只读 pass 结束：以下为纯计算，不再读取布局 ============

  const shapes: PagShape[] = [];
  for (let i = 0; i < kids.length; i++) {
    const g = topGeoms[i];
    if (g.height <= 0) continue; // 隐藏/空块不参与分页
    const { kind, level } = classify(kids[i]);
    // el：原始 DOM 引用，供渲染层按卡 cloneNode（纯逻辑层不读写）
    const shape: PagShape = { top: g.top, height: g.height, kind, level, el: kids[i] };
    const children = childReads[i]
      .filter((r) => r.geom.height > 0)
      .map((r) => {
        // 子块只带自身语义（嵌套层级不展开，level 保持其原始分类）
        const c = classify(r.el);
        return {
          top: r.geom.top,
          height: r.geom.height,
          kind: c.kind,
          level: c.level,
          el: r.el,
        };
      });
    if (children.length > 0) shape.children = children;
    shapes.push(shape);
  }
  return shapes;
}
