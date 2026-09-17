import { useState } from "react";
import { actions, appStore, useApp } from "../lib/store";

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

function AppearancePane() {
  const app = useApp();
  return (
    <div>
      <PaneTitle title="外观" desc="主题与字号实时生效，并随会话自动保存。" />
      <Card>
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
          <div className="flex items-center gap-2">
            <button className="icon-btn border border-border-app" onClick={() => bumpFont(-1)} title="减小字号">
              <span className="px-1 text-[13px]">A-</span>
            </button>
            <span className="w-10 text-center text-[13px] text-text-1">{app.fontSize}px</span>
            <button className="icon-btn border border-border-app" onClick={() => bumpFont(1)} title="增大字号">
              <span className="px-1 text-[13px]">A+</span>
            </button>
            <button className="px-2 text-[12px] text-text-3 hover:text-text-1" onClick={() => updateUi({ fontSize: 17 })}>
              恢复默认
            </button>
          </div>
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
          <KeyRow keys="Ctrl + Shift + F" desc="打开 / 关闭全文搜索" />
          <KeyRow keys="Ctrl + = / Ctrl + -" desc="增大 / 减小字号" />
          <KeyRow keys="Ctrl + 0" desc="恢复默认字号" />
          <KeyRow keys="Esc" desc="关闭图片查看 / 搜索框" />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- 关于 ---------------- */

function AboutPane() {
  return (
    <div>
      <PaneTitle title="关于" desc="FreeMarkdown —— 本地 Markdown 阅读器。" />
      <Card>
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

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-lg border border-border-app bg-bg-elev px-4 py-1">
      {title && <h2 className="pt-2 text-[13px] font-medium text-text-1">{title}</h2>}
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
  return (
    <div className="flex rounded-md border border-border-app p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          className={`rounded px-3 py-1 text-[12px] ${o.value === value ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:text-text-1"}`}
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
        className="absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all"
        style={{ left: on ? 22 : 3 }}
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
