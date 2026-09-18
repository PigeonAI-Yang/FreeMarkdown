import type { CardSettings } from "./templates/types";
import { DEFAULT_TEMPLATE_ID } from "./templates/registry";

type Listener = () => void;

/** 轻量 Store（与 lib/store.ts 的 Store 结构一致，避免循环依赖） */
class CardStore<T extends object> {
  private listeners = new Set<Listener>();
  constructor(public state: T) {}
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  get = () => this.state;
  set = (patch: Partial<T>) => {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  };
}

/** 保存回调由 session 层注入（避免循环依赖） */
let markDirty: (() => void) | null = null;
export function setCardSaveHook(fn: () => void) {
  markDirty = fn;
}

/** 卡片导出默认选项 */
export const DEFAULT_CARD_SETTINGS: CardSettings = {
  templateId: DEFAULT_TEMPLATE_ID,
  shell: "none",
  fontFamily: "",
  /** 空 = 跟随模板推荐字体链 */
  customFontName: "",
  fontSize: 16,
  /** 空 = 跟随模板自带强调色（目前用于水印与根变量 --card-accent） */
  accentColor: "",
  scale: 2,
  format: "png",
  jpegQuality: 0.92,
  mode: "long",
  /** 拆卡单卡内容高度预算 px */
  pageHeight: 1000,
  watermark: {
    enabled: false,
    text: "",
    position: "br",
    opacity: 0.35,
    size: 14,
  },
};

/** 卡片导出选项（非文档态，全局一份；持久化走 session.card） */
export const cardStore = new CardStore<CardSettings>({ ...DEFAULT_CARD_SETTINGS });

/** 修改选项并标记会话待保存 */
export function updateCard(patch: Partial<CardSettings>) {
  cardStore.set(patch);
  markDirty?.();
}

/** 启动时从 session 恢复 */
export function restoreCardSettings(saved: Partial<CardSettings> | undefined) {
  cardStore.set({ ...DEFAULT_CARD_SETTINGS, ...saved });
}
