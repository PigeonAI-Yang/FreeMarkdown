import { useLayoutEffect, useRef, useState } from "react";
import { actions, appStore, useApp, type DocWidth } from "../lib/store";

/**
 * 全屏设置页：独占整个窗口（不显示顶部工具栏与阅读区）。
 * 左侧分类导航 + 中间内容区。关闭后回到阅读现场（dock 状态不受影响）。
 */
export function SettingsPage() {
  const app = useApp();
  const [category, setCategory] = useState("appearance");

  return (
    <div className="flex min-h-0 flex-1 bg-bg">
      {/* 左侧分类导航 */}
      <aside className="flex w-56 flex-none flex-col border-r border-border-app bg-bg">
        <nav className="flex flex-col gap-0.5 px-2.5 pt-5">
          <button
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-text-2 hover:bg-bg-hover hover:text-text-1"
            onClick={() => updateUi({ settingsOpen: false })}
            title="返回阅读"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            返回阅读
          </button>
          <div className="mx-1 my-2 h-px bg-border-app" />
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] ${
                category === c.id
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-text-2 hover:bg-bg-hover hover:text-text-1"
              }`}
              onClick={() => setCategory(c.id)}
            >
              {c.icon}
              {c.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* 中间内容区 */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-10 py-8">
          {category === "appearance" && <AppearancePane />}
          {category === "reading" && <ReadingPane />}
          {category === "search" && <SearchPane />}
          {category === "shortcuts" && <ShortcutsPane />}
          {category === "about" && <AboutPane />}
        </div>
      </div>
    </div>
  );
}

const DOC_BG_PRESETS_LIGHT = ["#f7f1e6", "#f4f4f4", "#ffffff", "#e8f0e8"];
const DOC_BG_PRESETS_DARK = ["#232323", "#1b1b1b", "#2a2a2a", "#1e2a1e"];

const CATEGORIES = [
  {
    id: "appearance",
    label: "外观",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "reading",
    label: "阅读",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z" strokeLinejoin="round" />
        <path d="M4 19a2 2 0 012-2h13" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "search",
    label: "搜索",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="11" cy="11" r="6" />
        <path d="M20 20l-4.5-4.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "shortcuts",
    label: "快捷键",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="7" width="18" height="11" rx="2" />
        <path d="M7 11h.01M11 11h.01M15 11h.01M17.5 14.5h-11" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "关于",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" strokeLinecap="round" />
        <circle cx="12" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
];

/* ---------------- 外观 ---------------- */

/** 颜色行：预设色块 + 自定义 color input，按主题绑定 */
function ColorRow({
  label,
  presets,
  value,
  onChange,
}: {
  label: string;
  presets: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-2">
        {presets.map((c) => (
          <button
            key={c}
            className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
              value === c ? "border-accent" : "border-border-app"
            }`}
            style={{ background: c }}
            title={c}
            onClick={() => onChange(c)}
          />
        ))}
        <input
          type="color"
          className="h-6 w-6 cursor-pointer rounded-full border-2 border-border-app"
          value={value}
          title="自定义颜色"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </Row>
  );
}

/** 步进器：−/+ 调数值 */
function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = "",
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        className="icon-btn border border-border-app"
        onClick={() => onChange(Math.max(min, value - step))}
        title="减小"
      >
        <span className="px-1 text-[13px]">−</span>
      </button>
      <span className="w-12 text-center text-[13px] text-text-1">
        {value}{unit}
      </span>
      <button
        className="icon-btn border border-border-app"
        onClick={() => onChange(Math.min(max, value + step))}
        title="增大"
      >
        <span className="px-1 text-[13px]">+</span>
      </button>
    </div>
  );
}

const PRESETS_LIGHT = {
  docBg: ["#f7f1e6", "#f4f4f4", "#ffffff", "#e8f0e8"],
  floatBg: ["#ebe4d5", "#e8e8e8", "#f0f0f0", "#e0e8e0"],
  edGutter: ["#a8a299", "#8b949e", "#6e7781", "#59636e"],
  edMark: ["#a89e8a", "#8b949e", "#6e7781", "#59636e"],
  edHeading: ["#4f5bd5", "#0969da", "#8250df", "#1a7f37"],
  edCode: ["#b25e09", "#cf222e", "#953800", "#0550ae"],
  edString: ["#0a7f4f", "#1a7f37", "#116329", "#8250df"],
  edMatch: ["#ffd8a8", "#fff8c5", "#ffdfb6", "#ffebe9"],
};

const PRESETS_DARK = {
  docBg: ["#232323", "#1b1b1b", "#2a2a2a", "#1e2a1e"],
  floatBg: ["#1f1f1f", "#2c2c2c", "#353535", "#252d25"],
  edGutter: ["#5f5f5f", "#8b949e", "#7d8590", "#a0a0a0"],
  edMark: ["#6e6e6e", "#8b949e", "#7d8590", "#59636e"],
  edHeading: ["#7ab7ff", "#79c0ff", "#d2a8ff", "#7ee787"],
  edCode: ["#e5a06a", "#ff7b72", "#ffa657", "#79c0ff"],
  edString: ["#7dd3a8", "#7ee787", "#56d364", "#a5d6ff"],
  edMatch: ["#4a4020", "#5a4a1e", "#6b4a2a", "#3d3a1e"],
};

function AppearancePane() {
  const app = useApp();
  const isDark = app.theme === "dark";
  const P = isDark ? PRESETS_DARK : PRESETS_LIGHT;

  // 按主题取当前色值
  const pick = <K extends keyof typeof PRESETS_LIGHT>(key: K) =>
    isDark ? app[`${key}Dark` as keyof typeof app] : app[`${key}Light` as keyof typeof app];
  // 按主题写色值
  const set = (key: string, v: string) =>
    updateUi({ [isDark ? `${key}Dark` : `${key}Light`]: v });

  // 各卡默认值（按主题取）
  const resetGeneral = () =>
    updateUi({ fontSize: 17, docWidth: "medium", codeWrap: true });
  const resetSidebar = () =>
    updateUi({ sidebarWidth: 240, tocWidth: 240 });
  const resetDocColors = () =>
    updateUi(
      isDark
        ? { docBgDark: "#232323", floatBgDark: "#1f1f1f" }
        : { docBgLight: "#f7f1e6", floatBgLight: "#ebe4d5" },
    );
  const resetEditorColors = () =>
    updateUi(
      isDark
        ? {
            edGutterDark: "#5f5f5f",
            edMarkDark: "#6e6e6e",
            edHeadingDark: "#7ab7ff",
            edCodeDark: "#e5a06a",
            edStringDark: "#7dd3a8",
            edMatchDark: "#4a4020",
          }
        : {
            edGutterLight: "#a8a299",
            edMarkLight: "#a89e8a",
            edHeadingLight: "#4f5bd5",
            edCodeLight: "#b25e09",
            edStringLight: "#0a7f4f",
            edMatchLight: "#ffd8a8",
          },
    );

  return (
    <div>
      <PaneTitle title="外观" desc="主题与字号实时生效；颜色类按当前主题绑定，切主题自动切换。" />
      {/* 通用 */}
      <Card title="通用" onReset={resetGeneral}>
        <Row label="主题">
          <Segmented
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            value={app.theme}
            onChange={(v) => updateUi({ theme: v as "light" | "dark" })}
          />
        </Row>
        <Row label="正文字号">
          <Stepper
            value={app.fontSize}
            onChange={(v) => updateUi({ fontSize: v })}
            min={14}
            max={24}
            unit="px"
          />
        </Row>
        <Row label="阅读栏宽">
          <Segmented
            options={[
              { value: "narrow", label: "窄" },
              { value: "medium", label: "中" },
              { value: "wide", label: "宽" },
              { value: "full", label: "全宽" },
            ]}
            value={app.docWidth}
            onChange={(v) => updateUi({ docWidth: v as DocWidth })}
          />
        </Row>
        <Row label="代码块换行">
          <Toggle on={app.codeWrap} onChange={(v) => updateUi({ codeWrap: v })} />
        </Row>
      </Card>

      {/* 侧栏 */}
      <Card title="侧栏" onReset={resetSidebar}>
        <Row label="侧边栏宽度">
          <Stepper
            value={app.sidebarWidth}
            onChange={(v) => updateUi({ sidebarWidth: v })}
            min={180}
            max={480}
            step={20}
            unit="px"
          />
        </Row>
        <Row label="目录宽度">
          <Stepper
            value={app.tocWidth}
            onChange={(v) => updateUi({ tocWidth: v })}
            min={180}
            max={480}
            step={20}
            unit="px"
          />
        </Row>
      </Card>

      {/* 阅读区颜色 */}
      <Card title="阅读区" onReset={resetDocColors}>
        <ColorRow
          label="正文底色"
          presets={P.docBg}
          value={pick("docBg") as string}
          onChange={(v) => set("docBg", v)}
        />
        <ColorRow
          label="浮层底色"
          presets={P.floatBg}
          value={pick("floatBg") as string}
          onChange={(v) => set("floatBg", v)}
        />
      </Card>

      {/* 编辑器颜色 */}
      <Card title="编辑器" onReset={resetEditorColors}>
        <ColorRow
          label="行号"
          presets={isDark ? PRESETS_DARK.edGutter : PRESETS_LIGHT.edGutter}
          value={pick("edGutter") as string}
          onChange={(v) => set("edGutter", v)}
        />
        <ColorRow
          label="标记符号（# * ` >）"
          presets={P.edMark}
          value={pick("edMark") as string}
          onChange={(v) => set("edMark", v)}
        />
        <ColorRow
          label="标题"
          presets={P.edHeading}
          value={pick("edHeading") as string}
          onChange={(v) => set("edHeading", v)}
        />
        <ColorRow
          label="代码"
          presets={P.edCode}
          value={pick("edCode") as string}
          onChange={(v) => set("edCode", v)}
        />
        <ColorRow
          label="字符串"
          presets={P.edString}
          value={pick("edString") as string}
          onChange={(v) => set("edString", v)}
        />
        <ColorRow
          label="搜索匹配"
          presets={P.edMatch}
          value={pick("edMatch") as string}
          onChange={(v) => set("edMatch", v)}
        />
      </Card>

      {/* 编辑器排版（不分主题） */}
      <Card title="编辑器排版" onReset={() => updateUi({ edFontSize: 13, edLineHeight: 1.7 })}>
        <Row label="字号">
          <Stepper
            value={app.edFontSize}
            onChange={(v) => updateUi({ edFontSize: v })}
            min={11}
            max={20}
            unit="px"
          />
        </Row>
        <Row label="行高">
          <Stepper
            value={Math.round(app.edLineHeight * 10)}
            onChange={(v) => updateUi({ edLineHeight: v / 10 })}
            min={12}
            max={24}
            step={1}
            unit=""
          />
        </Row>
      </Card>
    </div>
  );
}

/* ---------------- 阅读 ---------------- */

function ReadingPane() {
  const app = useApp();
  return (
    <div>
      <PaneTitle title="阅读" desc="控制阅读区的面板显隐与打开方式。" />
      <Card>
        <Row label="资源侧边栏">
          <Toggle on={app.sidebarVisible} onChange={(v) => updateUi({ sidebarVisible: v })} />
        </Row>
        <Row label="目录（TOC）">
          <Toggle on={app.tocVisible} onChange={(v) => updateUi({ tocVisible: v })} />
        </Row>
      </Card>
      <Card title="打开">
        <div className="flex gap-2 py-1">
          <button className="icon-btn border border-border-app px-3 text-[12px]" onClick={() => actions.pickFile()}>
            选择文件…
          </button>
          <button className="icon-btn border border-border-app px-3 text-[12px]" onClick={() => actions.pickFolder()}>
            选择文件夹…
          </button>
        </div>
        <p className="pb-2 text-[12px] text-text-3">
          也可以把 .md 文件或文件夹直接拖进窗口打开。
        </p>
      </Card>
    </div>
  );
}

/* ---------------- 搜索 ---------------- */

function SearchPane() {
  const app = useApp();
  return (
    <div>
      <PaneTitle title="搜索" desc="全文搜索扫描当前文件夹下的全部 Markdown。" />
      <Card>
        <Row label="搜索面板">
          <Toggle on={app.searchOpen} onChange={(v) => updateUi({ searchOpen: v })} />
        </Row>
        <Row label="搜索范围">
          <span className="max-w-70 truncate text-[12px] text-text-2" title={app.rootFolder ?? ""}>
            {app.rootFolder ?? "未打开文件夹（先打开一个文件夹）"}
          </span>
        </Row>
      </Card>
      <Card title="说明">
        <ul className="space-y-1.5 pb-2 text-[13px] leading-6 text-text-2">
          <li>· 输入关键词后 250ms 自动搜索，Rust 多线程并行扫描。</li>
          <li>· 点击命中条目打开文档并定位到对应行，高亮保留到下次跳转。</li>
          <li>· 超过 1000 条命中时截断显示，可缩小范围或加长关键词。</li>
        </ul>
      </Card>
    </div>
  );
}

/* ---------------- 快捷键 ---------------- */

function ShortcutsPane() {
  return (
    <div>
      <PaneTitle title="快捷键" desc="全局可用，输入框聚焦时除外。" />
      <Card>
        <div className="space-y-1.5 py-1 text-[13px] text-text-2">
          <KeyRow keys="Ctrl + O" desc="打开 Markdown 文件" />
          <KeyRow keys="Ctrl + Shift + O" desc="打开文件夹" />
          <KeyRow keys="Ctrl + S" desc="保存当前文档" />
          <KeyRow keys="Ctrl + Z / Ctrl + Y" desc="撤销 / 重做" />
          <KeyRow keys="Ctrl + F / Ctrl + Shift + F" desc="打开 / 关闭全文搜索" />
          <KeyRow keys="Ctrl + = / Ctrl + -" desc="增大 / 减小字号" />
          <KeyRow keys="Ctrl + 滚轮" desc="阅读区缩放字号" />
          <KeyRow keys="Ctrl + 0" desc="恢复默认字号" />
          <KeyRow keys="Esc" desc="关闭图片查看 / 搜索框" />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- 关于 ---------------- */

function AboutPane() {
  const app = useApp();
  return (
    <div>
      <PaneTitle title="关于" desc="FreeMarkdown —— 本地 Markdown 阅读器。" />
      <Card>
        <div className="flex items-center gap-3 py-2">
          <img src="/freemarkdown-icon.svg" width={48} height={48} alt="FreeMarkdown 图标" />
          <div>
            <div className="text-[14px] font-medium text-text-1">FreeMarkdown</div>
            <div className="text-[12px] text-text-3">本地 Markdown 阅读器</div>
          </div>
        </div>
        <dl className="space-y-1.5 py-1 text-[13px]">
          <div className="flex gap-3">
            <dt className="w-16 flex-none text-text-3">版本</dt>
            <dd className="text-text-1">0.1.0</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 flex-none text-text-3">解析</dt>
            <dd className="text-text-1">Rust comrak（GFM），后台线程，一次性注入 HTML</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 flex-none text-text-3">布局</dt>
            <dd className="text-text-1">dockview 多窗格，退出自动保存现场</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-16 flex-none text-text-3">许可</dt>
            <dd className="text-text-1">仅使用 MIT / Apache-2.0 / BSD 依赖</dd>
          </div>
        </dl>
      </Card>
      <Card title="开发者">
        <Row label="诊断模式">
          <Toggle on={app.diagnosticMode} onChange={(v) => updateUi({ diagnosticMode: v })} />
        </Row>
        <p className="pb-2 text-[12px] text-text-3">
          打开后搜索面板显示调试信息（搜索范围/命中数/当前文档路径）。
        </p>
      </Card>
    </div>
  );
}

/* ---------------- 通用小组件 ---------------- */

function updateUi(patch: Parameters<typeof appStore.set>[0]) {
  appStore.set(patch);
  void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
}

function bumpFont(delta: number) {
  const cur = appStore.get().fontSize;
  updateUi({ fontSize: Math.min(24, Math.max(14, cur + delta)) });
}

function PaneTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-3">
      <h1 className="text-xl font-semibold text-text-1">{title}</h1>
      <p className="mt-1 text-[13px] text-text-3">{desc}</p>
    </div>
  );
}

function Card({
  title,
  onReset,
  children,
}: {
  title?: string;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 rounded-lg border border-border-app bg-bg-elev px-4 py-1">
      {(title || onReset) && (
        <div className="flex items-center justify-between pt-2">
          {title && <h2 className="text-[13px] font-medium text-text-1">{title}</h2>}
          {onReset && (
            <button
              className="text-[11px] text-text-3 hover:text-text-1"
              onClick={onReset}
            >
              恢复默认
            </button>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-app py-2.5 last:border-0">
      <span className="text-[13px] text-text-2">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  // 测量激活按钮的实际位置，指示器用 transform 滑动（GPU 合成）
  useLayoutEffect(() => {
    const el = containerRef.current?.querySelector(`[data-value="${value}"]`) as HTMLElement | null;
    if (el) {
      setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
    }
  }, [value, options]);

  return (
    <div ref={containerRef} className="relative flex rounded-md border border-border-app p-0.5">
      {/* 滑动指示器：GPU transform，不触发 layout */}
      {indicator && (
        <span
          className="absolute top-0.5 bottom-0.5 rounded-md bg-accent-soft"
          style={{
            width: indicator.width,
            transform: `translateX(${indicator.left}px)`,
            transition: "transform 200ms cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          data-value={o.value}
          className={`relative z-10 rounded px-3 py-1 text-[12px] transition-colors ${
            o.value === value ? "font-medium text-accent" : "text-text-2 hover:text-text-1"
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative rounded-full transition-colors ${on ? "bg-accent" : "bg-bg-active"}`}
      style={{ height: 22, width: 40 }}
    >
      <span
        className="absolute top-[3px] h-4 w-4 rounded-full shadow"
        style={{
          background: "var(--switch-thumb)",
          transform: `translateX(${on ? 19 : 0}px)`,
          transition: "transform 200ms cubic-bezier(0.4, 0, 0.2, 1)",
          left: 3,
        }}
      />
    </button>
  );
}

function KeyRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border-app py-2 last:border-0">
      <span>{desc}</span>
      <kbd className="rounded border border-border-app bg-bg px-1.5 py-0.5 font-mono text-[11px] text-text-2">
        {keys}
      </kbd>
    </div>
  );
}
