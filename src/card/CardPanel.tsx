import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview";
import { api, basename } from "../lib/ipc";
import { enhanceChunk } from "../lib/enhance";
import { cardStore, updateCard } from "./cardStore";
import { TEMPLATES, getTemplate } from "./templates/registry";
import type { CardSettings, WatermarkOptions } from "./templates/types";
import { collectNodes, computeCuts, flattenUnits, type CardCut, type PagShape } from "./engine/paginate";
import { localizeImages } from "./engine/images";
import { ensureFontReady, importFontFile, listSystemFonts } from "./engine/fonts";
import { DeviceShell } from "./shells/DeviceShell";
import { exportClipboard, exportSave } from "./engine/export";
import "./card-panel.css";

/**
 * 卡片导出面板：左侧选项控制栏 + 右侧整卡预览舞台 + 底部导出操作条。
 *
 * 性能要点：
 * - 分页测量只走 collectNodes 的单次只读 pass；面板自身只额外做
 *   「探针高度 400px」与最终 offsetHeight 两次单点读取，不做第二轮全量扫描；
 * - 拆卡模式每卡独立小 DOM：applyCut 按 CardCut.start/end 只把本卡覆盖的
 *   内容块 cloneNode 进内容容器，捕获根不再携带全量文档——大文档下
 *   snapdom 每次只序列化本卡几个块（全量 DOM 在测量完成后即被替换掉）；
 * - 长图模式保持全量内容 DOM 一次注入一次捕获；
 * - 导出走 export.ts 顺序逐张捕获，位图即用即弃；
 * - 管线 150ms 防抖 + runId token，连续改设置只跑最后一次，旧请求作废。
 */

type Phase = "loading" | "ready" | "empty" | "error";

const PIPELINE_DEBOUNCE_MS = 150;
/** 探针内容窗高度：临时撑起视口以实测 chrome（外壳 + 页眉页脚装饰）总高 */
const PROBE_HEIGHT = 400;
/** 导入字体选项的哨兵值 */
const IMPORT_SENTINEL = "__import__";

/* ---------------- 小控件 ---------------- */

/** 纵向字段行（标签 + 控件） */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="card-field">
      <span className="card-field-label">{label}</span>
      {children}
    </label>
  );
}

/**
 * 数字输入：本地 raw 状态允许自由键入（不为中间态空串/半截数字打架），
 * 合法数字即时按 min/max 收敛提交，失焦后回到外部值。
 */
function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  return (
    <Field label={props.label}>
      <input
        className="card-input"
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={raw ?? String(props.value)}
        onChange={(e) => {
          setRaw(e.target.value);
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) {
            props.onCommit(Math.min(props.max, Math.max(props.min, n)));
          }
        }}
        onBlur={() => setRaw(null)}
      />
    </Field>
  );
}

/* ---------------- 面板主体 ---------------- */

export function CardPanel(props: IDockviewPanelProps<{ path: string }>) {
  const path = props.params.path;
  const settings = useSyncExternalStore(cardStore.subscribe, cardStore.get);
  const tpl = getTemplate(settings.templateId);
  // 3:4 固定比例模板强制拆卡；不可分页模板强制长图
  const effMode: "long" | "paged" =
    tpl.aspect === "3:4" || (settings.mode === "paged" && tpl.paginatable)
      ? "paged"
      : "long";

  const [visible, setVisible] = useState(props.api.isVisible);
  const [phase, setPhase] = useState<Phase>("loading");
  const [err, setErr] = useState<string | null>(null);
  const [cuts, setCuts] = useState<CardCut[]>([]);
  const [cutIndex, setCutIndex] = useState(0);
  const [chromeH, setChromeH] = useState(0); // 外壳 + 页眉页脚装饰总高
  const [longH, setLongH] = useState(0); // 长图整卡外高
  const [rootW, setRootW] = useState(0); // 卡外宽实测（含模板 padding）
  const [stageW, setStageW] = useState(0);
  const [fonts, setFonts] = useState<string[] | null>(null); // null = 读取中
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const runIdRef = useRef(0);
  // 命令式 DOM 操作与导出回调用的镜像 ref，避免闭包拿到过期值
  const cutsRef = useRef<CardCut[]>([]);
  const unitsRef = useRef<PagShape[]>([]); // flattenUnits 序列（拆卡按区间克隆的源头）
  const cutIndexRef = useRef(0);
  const aspectFixRef = useRef<number | null>(null);
  const modeRef = useRef(effMode);
  modeRef.current = effMode;
  cutIndexRef.current = cutIndex;

  const baseName = useMemo(
    () => basename(path).replace(/\.[^.]+$/, ""),
    [path],
  );
  const fontChain = useMemo(() => {
    // 自定义导入字体 > 用户自选系统字体 > 模板推荐字体链
    const custom = settings.customFontName || settings.fontFamily;
    return custom ? `"${custom}", ${tpl.recommendFont}` : tpl.recommendFont;
  }, [settings.customFontName, settings.fontFamily, tpl]);

  /* -- 面板隐藏时冻结（与 MarkdownPane 同策略：不保留测量/导出 DOM） -- */
  useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  /* -- 系统字体列表：挂载后惰性加载（模块级 memo，不重复请求） -- */
  useEffect(() => {
    let alive = true;
    listSystemFonts().then((f) => {
      if (alive) setFonts(f);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* -- 拆卡模式：把本卡覆盖的内容块克隆进内容容器（每卡独立小 DOM）。
        大文档性能的关键路径：捕获根只含本卡几个块，snapdom 每次只序列化这一小棵
        子树，不再随全量文档规模线性恶化。克隆继承增强后的静态 DOM
        （图片已转 dataURL、mermaid/katex/hljs 已定格），无需重新增强。 -- */
  const buildCardDom = useCallback((cut: CardCut) => {
    const ct = contentRef.current;
    const units = unitsRef.current;
    if (!ct || units.length === 0) return;
    ct.innerHTML = ""; // 先清空再装本卡块，避免残留上一卡内容
    ct.appendChild(buildCutFragment(units, cut));
  }, []);

  /* -- 把第 i 卡落到预览视口（命令式，供翻页与导出共用） -- */
  const applyCut = useCallback(
    (i: number) => {
      const vp = viewportRef.current;
      const ct = contentRef.current;
      if (!vp || !ct) return;
      if (modeRef.current === "paged" && cutsRef.current.length > 0) {
        const arr = cutsRef.current;
        const cut = arr[Math.max(0, Math.min(i, arr.length - 1))];
        buildCardDom(cut); // 每卡独立小 DOM：克隆本卡块替换容器内容
        // 3:4 模板视口定高（aspectFix），其余按每卡内容高；
        // 克隆内容天然从卡顶排布，无需再对容器做 translateY 平移
        vp.style.height = `${Math.round(aspectFixRef.current ?? cut.height)}px`;
        ct.style.transform = "";
      } else {
        // 长图模式：全量内容 DOM 一次注入一次捕获（超大文档由 resolveScale 兜底）
        vp.style.height = "auto";
        ct.style.transform = "";
      }
    },
    [buildCardDom],
  );

  useEffect(() => {
    applyCut(cutIndex);
  }, [applyCut, cuts, cutIndex, effMode]);

  /* -- 预览管线：读文档 → 注入 → 增强 → 本地化图片 → 字体 → 测量切卡 -- */
  useEffect(() => {
    const my = ++runIdRef.current;
    const stale = () => my !== runIdRef.current;
    setPhase("loading");
    setErr(null);
    setStatus(null);
    cutsRef.current = [];
    unitsRef.current = [];
    setCuts([]);
    setCutIndex(0);

    const run = async () => {
      const t0 = performance.now();
      try {
        const root = rootRef.current;
        const vp = viewportRef.current;
        const el = contentRef.current;
        if (!root || !vp || !el) return; // 面板隐藏冻结中，可见后重跑

        // 1. 读文档（后端 LRU 命中零解析）
        const doc = await api.readMarkdown(path);
        if (stale()) return;
        const html = doc.chunks.join("");
        if (!html.trim()) {
          el.innerHTML = "";
          setPhase("empty");
          return;
        }
        // 2. 注入
        el.innerHTML = html;
        // 3. 增强（mermaid 主题跟随模板明暗）
        await enhanceChunk(el, { mermaidTheme: tpl.dark ? "dark" : "light" });
        if (stale()) return;
        // 4. 本地图片转 data URL（snapdom foreignObject 需离线内嵌）
        await localizeImages(el);
        if (stale()) return;
        // 5. 自选字体预载，保证测量与捕获用同一套字形
        const font = settings.customFontName || settings.fontFamily;
        if (font) await ensureFontReady(font);
        if (stale()) return;

        // 6. 探针实测 chrome：临时把内容窗撑到 400px，差值即装饰总高
        vp.style.height = `${PROBE_HEIGHT}px`;
        el.style.transform = "";
        const chrome = Math.max(0, root.offsetHeight - PROBE_HEIGHT);
        // 7-8. 唯一一轮全量布局读取（collectNodes）+ 纯函数切卡
        const nodes = collectNodes(el);
        const budget =
          tpl.aspect === "3:4"
            ? Math.round((tpl.width * 4) / 3) - chrome
            : settings.pageHeight - chrome;
        const nextCuts: CardCut[] =
          modeRef.current === "paged"
            ? computeCuts(nodes, Math.max(300, budget))
            : [{ top: 0, height: el.scrollHeight, start: 0, end: 0 }];
        if (stale()) return;
        if (nextCuts.length === 0) {
          setPhase("empty");
          return;
        }

        // 9. 落状态、恢复可见，由 applyCut 副作用铺最终几何
        cutsRef.current = nextCuts;
        // 拆卡模式：展开单元序列与 cuts 的 start/end 对齐，供按卡克隆
        if (modeRef.current === "paged") unitsRef.current = flattenUnits(nodes);
        setCuts(nextCuts);
        setChromeH(chrome);
        setRootW(root.offsetWidth);
        if (modeRef.current === "paged") {
          setCutIndex((c) => Math.min(c, nextCuts.length - 1));
        } else {
          vp.style.height = "auto";
          el.style.transform = "";
          setLongH(root.offsetHeight);
        }
        setPhase("ready");
        // 10. 耗时上报
        void api.perfLog("card-pipeline", Math.round(performance.now() - t0));
      } catch (e) {
        if (!stale()) {
          setErr(String(e));
          setPhase("error");
        }
      }
    };

    const timer = setTimeout(() => void run(), PIPELINE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      runIdRef.current += 1; // 使在途请求作废
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    path,
    reloadKey,
    visible,
    tpl,
    settings.templateId,
    settings.shell,
    settings.fontFamily,
    settings.customFontName,
    settings.fontSize,
    settings.mode,
    settings.pageHeight,
  ]);

  /* -- 舞台宽度监听，驱动预览缩放 -- */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver((entries) => {
      setStageW(entries[0].contentRect.width);
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, [visible]);

  /* -- 导出用：切到第 i 卡并等两次绘制帧，几何稳定后再捕获 -- */
  const prepareCard = useCallback(
    async (index: number) => {
      applyCut(index);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    },
    [applyCut],
  );
  const restore = useCallback(() => {
    applyCut(cutIndexRef.current);
  }, [applyCut]);

  /* -- 缩放与尺寸推导 -- */
  const cardW = rootW || tpl.width;
  // 3:4 固定比例：视口定高（内容不足留白，Frame 靠 flex:1 撑满），
  // 普通模板视口高度跟随每卡内容（cuts[i].height）
  const aspectFix =
    tpl.aspect === "3:4" && chromeH > 0
      ? Math.max(200, Math.round((tpl.width * 4) / 3) - chromeH)
      : null;
  const cardH =
    effMode === "paged" && cuts.length > 0
      ? chromeH + (aspectFix ?? cuts[Math.min(cutIndex, cuts.length - 1)].height)
      : longH;
  const fit =
    stageW > 48 && cardW > 0 ? Math.min(1, (stageW - 48) / cardW) : 0.25;
  aspectFixRef.current = aspectFix;

  /* -- 导出三按钮 -- */
  const doExport = async (target: "save" | "clipboard") => {
    const root = rootRef.current;
    if (!root || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      if (target === "save") {
        const res = await exportSave({
          rootEl: root,
          scale: settings.scale,
          format: settings.format,
          jpegQuality: settings.jpegQuality,
          backgroundColor: tpl.shellBg,
          docBaseName: baseName,
          cardCount: effMode === "paged" ? Math.max(1, cuts.length) : 1,
          onProgress: (p) => setProgress(`${p.done}/${p.total}`),
          prepareCard,
          restore,
        });
        setStatus(
          res.ok
            ? res.saved > 1
              ? `已保存 ${res.saved} 张到 ${res.message ?? "所选文件夹"}`
              : `已保存：${res.message ?? ""}`
            : (res.message ?? "导出失败"),
        );
      } else {
        const res = await exportClipboard({
          rootEl: root,
          scale: settings.scale,
          format: settings.format,
          jpegQuality: settings.jpegQuality,
          backgroundColor: tpl.shellBg,
          docBaseName: baseName,
          cardCount: 1, // 剪贴板只取当前预览卡
        });
        setStatus(res.ok ? "已复制到剪贴板" : (res.message ?? "复制失败"));
      }
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  /* -- 控制项 handlers（改动一律走 updateCard 持久化） -- */
  const setWm = (patch: Partial<WatermarkOptions>) =>
    updateCard({ watermark: { ...settings.watermark, ...patch } });

  const onFontChange = (v: string) => {
    if (v === IMPORT_SENTINEL) {
      fileRef.current?.click();
      return;
    }
    updateCard({ fontFamily: v, customFontName: "" });
  };

  const onFontFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const family = await importFontFile(f);
      updateCard({ customFontName: family });
    } catch (e) {
      setStatus(`字体导入失败：${String(e)}`);
    }
  };

  /* -- 面板隐藏时冻结为占位（重挂载后管线自动重跑） -- */
  if (!visible) {
    return <div className="frozen-placeholder" />;
  }

  /* 设备外壳（iPhone / macOS）：模板纸面（背景纹理 + 留白）改由设备内容区承载。
     此前纸面铺在卡片根上、外壳塞在卡片内边距里，模板的 padding 就变成了设备
     外面的一圈纸边（观感是"背景顶到设备外面"），屏幕里的正文反而几乎没有留白。
     外壳高度仍留在内容盒内，分页/比例测量逻辑不受影响。
     纸色必须内联清掉：模板规则 body .tpl-xxx 的特异性高于单个类名。 */
  const shellActive = settings.shell !== "none";

  const rootStyle = {
    // 定宽用模板声明值：实测 rootW 只用于缩放计算。若这里用 cardW，
    // 切到不同宽度模板（如 390 的 3:4 卡）会被上一个模板的实测宽锁死
    width: tpl.width,
    visibility: phase === "ready" ? "visible" : "hidden",
    ...(shellActive ? { background: "transparent" } : null),
    "--card-accent": settings.accentColor || undefined,
    "--card-root-bg": tpl.shellBg,
  } as CSSProperties;

  return (
    <div className="card-panel">
      {/* ============ 左侧控制栏 ============ */}
      <aside className="card-controls">
        <Field label="模板">
          <select
            className="card-input"
            value={settings.templateId}
            onChange={(e) => updateCard({ templateId: e.target.value })}
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="设备外壳">
          <select
            className="card-input"
            value={settings.shell}
            onChange={(e) =>
              updateCard({ shell: e.target.value as CardSettings["shell"] })
            }
          >
            <option value="none">无</option>
            <option value="iphone">iPhone</option>
            <option value="macos">macOS 窗口</option>
          </select>
        </Field>

        <Field
          label={
            tpl.aspect === "3:4"
              ? "导出模式（3:4 固定拆卡）"
              : tpl.paginatable
                ? "导出模式"
                : "导出模式（此模板不可拆卡）"
          }
        >
          <select
            className="card-input"
            value={effMode}
            disabled={!tpl.paginatable || tpl.aspect === "3:4"}
            onChange={(e) =>
              updateCard({ mode: e.target.value as CardSettings["mode"] })
            }
          >
            <option value="long">长图</option>
            <option value="paged">拆卡</option>
          </select>
        </Field>

        {effMode === "paged" && tpl.aspect !== "3:4" && (
          <NumberField
            label="拆卡内容高度（px）"
            value={settings.pageHeight}
            min={600}
            max={2000}
            step={50}
            onCommit={(n) => updateCard({ pageHeight: n })}
          />
        )}

        <Field label="字体">
          <div className="flex items-center gap-1">
            <select
              className="card-input min-w-0 flex-1"
              value={settings.customFontName || settings.fontFamily}
              onChange={(e) => onFontChange(e.target.value)}
            >
              <option value="">模板默认</option>
              {fonts === null && <option disabled>读取系统字体…</option>}
              {fonts?.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
              {settings.customFontName && (
                <option value={settings.customFontName}>
                  {settings.customFontName}（已导入）
                </option>
              )}
              <option value={IMPORT_SENTINEL}>导入字体…</option>
            </select>
            {settings.customFontName && (
              <button
                className="icon-btn h-6 min-w-6 border border-border-app text-[12px]"
                title="清除自定义字体"
                onClick={() => updateCard({ customFontName: "" })}
              >
                ×
              </button>
            )}
          </div>
        </Field>
        {/* 隐藏的字体文件入口（.ttf/.otf） */}
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf"
          className="hidden"
          onChange={(e) => {
            void onFontFile(e.target.files?.[0]);
            e.target.value = ""; // 允许重复选同一文件
          }}
        />

        <NumberField
          label="内容字号（px）"
          value={settings.fontSize}
          min={12}
          max={24}
          onCommit={(n) => updateCard({ fontSize: n })}
        />

        <Field label="导出缩放">
          <select
            className="card-input"
            value={settings.scale}
            onChange={(e) =>
              updateCard({ scale: Number(e.target.value) as CardSettings["scale"] })
            }
          >
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={3}>3x</option>
          </select>
        </Field>

        <Field label="格式">
          <select
            className="card-input"
            value={settings.format}
            onChange={(e) =>
              updateCard({ format: e.target.value as CardSettings["format"] })
            }
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
          </select>
        </Field>

        {settings.format === "jpeg" && (
          <NumberField
            label="JPEG 质量"
            value={settings.jpegQuality}
            min={0.5}
            max={1}
            step={0.02}
            onCommit={(n) => updateCard({ jpegQuality: n })}
          />
        )}

        <div className="card-field">
          <label className="flex items-center gap-2 text-[12px] text-text-2">
            <input
              type="checkbox"
              checked={settings.watermark.enabled}
              onChange={(e) => setWm({ enabled: e.target.checked })}
            />
            启用水印
          </label>
          {settings.watermark.enabled && (
            <>
              <input
                className="card-input"
                type="text"
                placeholder="水印文字"
                value={settings.watermark.text}
                onChange={(e) => setWm({ text: e.target.value })}
              />
              <select
                className="card-input"
                value={settings.watermark.position}
                onChange={(e) =>
                  setWm({ position: e.target.value as WatermarkOptions["position"] })
                }
              >
                <option value="tl">左上</option>
                <option value="tr">右上</option>
                <option value="bl">左下</option>
                <option value="br">右下</option>
                <option value="center">居中</option>
              </select>
              <span className="card-field-label">
                不透明度 {settings.watermark.opacity.toFixed(2)}
              </span>
              <input
                type="range"
                className="card-range"
                min={0.1}
                max={0.9}
                step={0.05}
                value={settings.watermark.opacity}
                onChange={(e) => setWm({ opacity: Number(e.target.value) })}
              />
              <NumberField
                label="水印字号（px）"
                value={settings.watermark.size}
                min={10}
                max={40}
                onCommit={(n) => setWm({ size: n })}
              />
            </>
          )}
        </div>
      </aside>

      {/* ============ 右侧预览 + 操作条 ============ */}
      <div className="card-preview">
        <section className="card-stage" ref={stageRef}>
          {phase === "loading" && (
            <div className="card-msg">
              <span className="text-[12px] text-text-3">正在生成预览…</span>
            </div>
          )}
          {phase === "empty" && (
            <div className="card-msg">
              <span className="text-[12px] text-text-3">
                空文档，没有可导出的内容
              </span>
            </div>
          )}
          {phase === "error" && (
            <div className="card-msg">
              <span className="max-w-100 text-[12px] text-text-2">
                预览失败：{err}
              </span>
              <button
                className="icon-btn border border-border-app px-3 text-[12px]"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                重试
              </button>
            </div>
          )}
          {(
            /* 布局盒 = 缩放后尺寸，视觉由 transform 收缩到同一矩形（见 css）。
               捕获树常驻挂载：run() 依赖三个 refs，若仅 ready 相位挂载，
               refs 永远为空 → 静默 return → 永远到不了 ready（死锁）。
               loading 期间由 rootStyle visibility 隐藏，不影响布局测量。 */
            <div
              className="card-scale"
              style={{
                width: Math.round(cardW * fit),
                height: Math.round(cardH * fit),
                transform: `scale(${fit})`,
                transformOrigin: "top center",
              }}
            >
              <div
                className={`card-root ${tpl.contentClass}${shellActive ? " card-root--shell" : ""}`}
                ref={rootRef}
                style={rootStyle}
              >
                <DeviceShell
                  kind={settings.shell}
                  title={baseName}
                  contentClass={shellActive ? tpl.contentClass : undefined}
                >
                  <tpl.Frame
                    ctx={{
                      settings,
                      pageIndex: cutIndex,
                      pageCount: cuts.length || 1,
                      docTitle: baseName,
                    }}
                  >
                    {/* 高度/位移由 applyCut 命令式管理，不进 React 样式 */}
                    <div className="card-viewport" ref={viewportRef}>
                      <div
                        className="markdown-body"
                        ref={contentRef}
                        style={{ fontSize: settings.fontSize, fontFamily: fontChain }}
                      />
                    </div>
                  </tpl.Frame>
                </DeviceShell>
                {/* 水印覆盖层：随卡导出，不随内容翻页移动 */}
                {settings.watermark.enabled && settings.watermark.text && (
                  <div className="card-watermark" style={watermarkStyle(settings.watermark)}>
                    {settings.watermark.text}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <footer className="card-actions">
          <div className="card-pager">
            {effMode === "paged" && cuts.length > 0 && (
              <>
                <button
                  className="icon-btn h-6 min-w-6 border border-border-app text-[14px]"
                  disabled={busy || cutIndex <= 0}
                  onClick={() => setCutIndex((c) => Math.max(0, c - 1))}
                  title="上一张"
                >
                  ‹
                </button>
                <span className="text-[12px] text-text-2">
                  第 {cutIndex + 1} / {cuts.length} 张
                </span>
                <button
                  className="icon-btn h-6 min-w-6 border border-border-app text-[14px]"
                  disabled={busy || cutIndex >= cuts.length - 1}
                  onClick={() => setCutIndex((c) => Math.min(cuts.length - 1, c + 1))}
                  title="下一张"
                >
                  ›
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {busy && <span className="text-[12px] text-text-3">{progress}</span>}
            {status && (
              <span className="card-status" title={status}>
                {status}
              </span>
            )}
            <button
              className="icon-btn border border-border-app px-3 text-[12px]"
              disabled={busy || phase !== "ready"}
              onClick={() => void doExport("save")}
            >
              保存
            </button>
            <button
              className="icon-btn border border-border-app px-3 text-[12px]"
              disabled={busy || phase !== "ready"}
              onClick={() => void doExport("clipboard")}
            >
              复制到剪贴板
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/* ---------------- 拆卡克隆组装 ---------------- */

/**
 * 把 [cut.start, cut.end] 覆盖的内容块克隆组装为本卡 DOM：
 * - 顶层块直接 cloneNode(true)；
 * - 连续同源 list 的 li 合并包进原标签容器（ul/ol，复制原 list 元素全部属性，
 *   含 className 与 ol 的 start 计号）；连续同源 quote 的内块同理包进
 *   blockquote（属性同样整份复制）；顶层块打断合并；
 * - 同源判断用原 el.parentElement 的引用比较——同引用才合并，
 *   跨卡同列表出现两个 ul 属正常；
 * - 块 el 缺失时跳过（正常来自 collectNodes 的 units 不会缺失）。
 */
function buildCutFragment(units: PagShape[], cut: CardCut): DocumentFragment {
  const frag = document.createDocumentFragment();
  let holder: { el: HTMLElement; src: HTMLElement } | null = null;
  for (let k = cut.start; k <= cut.end && k < units.length; k++) {
    const u = units[k];
    const src = u.el;
    if (!src) continue;
    const clone = src.cloneNode(true) as HTMLElement;
    const origParent = u.parent ? src.parentElement : null;
    if (origParent && holder && holder.src === origParent) {
      holder.el.appendChild(clone); // 与上一块同源：合并进现有容器
      continue;
    }
    if (origParent) {
      const wrap: HTMLElement = document.createElement(origParent.tagName);
      for (const a of origParent.attributes) wrap.setAttribute(a.name, a.value);
      wrap.appendChild(clone);
      frag.appendChild(wrap);
      holder = { el: wrap, src: origParent };
    } else {
      frag.appendChild(clone);
      holder = null;
    }
  }
  return frag;
}

/* ---------------- 水印定位样式 ---------------- */

/** 五个锚位 → 绝对定位样式（内容坐标系 px，颜色走 --card-accent 兜底灰） */
function watermarkStyle(w: WatermarkOptions): CSSProperties {
  const inset = 20;
  const base: CSSProperties = {
    opacity: w.opacity,
    fontSize: w.size,
    color: "var(--card-accent, #808080)",
  };
  switch (w.position) {
    case "tl":
      return { ...base, top: inset, left: inset };
    case "tr":
      return { ...base, top: inset, right: inset };
    case "bl":
      return { ...base, bottom: inset, left: inset };
    case "br":
      return { ...base, bottom: inset, right: inset };
    case "center":
      return {
        ...base,
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      };
  }
}
