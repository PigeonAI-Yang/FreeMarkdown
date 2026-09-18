import type { ReactNode } from "react";

/** 设备外壳类型：无壳 / iPhone 边框（灵动岛）/ macOS 窗口条 */
export type ShellKind = "none" | "iphone" | "macos";

/** 导出图片格式 */
export type ExportFormat = "png" | "jpeg";

/** 水印配置（面板叠加层，不属于模板） */
export interface WatermarkOptions {
  enabled: boolean;
  text: string;
  position: "tl" | "tr" | "bl" | "br" | "center";
  /** 0 ~ 1 */
  opacity: number;
  /** px（内容坐标系） */
  size: number;
}

/** 卡片导出选项（持久化到 session.card） */
export interface CardSettings {
  templateId: string;
  shell: ShellKind;
  /** 系统字体 family 名；"" = 使用模板推荐字体链 */
  fontFamily: string;
  /** 已导入自定义字体的 family 名；非空时优先于 fontFamily */
  customFontName: string;
  /** 内容字号 px（作用于 .markdown-body） */
  fontSize: number;
  accentColor: string;
  scale: 1 | 2 | 3;
  format: ExportFormat;
  /** jpeg 质量 0.5 ~ 1 */
  jpegQuality: number;
  /** 单长图 / 拆多卡 */
  mode: "long" | "paged";
  /** 拆卡单卡内容高度预算 px */
  pageHeight: number;
  watermark: WatermarkOptions;
}

/** 模板渲染上下文 */
export interface TemplateContext {
  settings: CardSettings;
  /** 当前卡序号（0 起）；单长图恒为 0 */
  pageIndex: number;
  /** 总卡数；单长图恒为 1 */
  pageCount: number;
  docTitle: string;
}

/** 模板自带卡内装饰（页眉/页脚/页码），与设备外壳相互独立 */
export interface FrameProps {
  ctx: TemplateContext;
  /** 装饰总高度（页眉+页脚）需占用内容预算，CardPanel 实测后扣除 */
  children: ReactNode;
}

/**
 * 卡片模板定义。
 * 内容渲染复用 .markdown-body（github-markdown-css），模板通过 contentClass
 * 以 CSS 变量与排版覆盖实现主题，不引入第二个 markdown 渲染器。
 */
export interface CardTemplate {
  id: string;
  name: string;
  /** 内容宽 px */
  width: number;
  /** 固定比例卡（小红书 3:4）；free = 高度随内容 */
  aspect?: "3:4" | "free";
  /** 主题类，挂在与 .markdown-body 同级的包装元素上 */
  contentClass: string;
  /** 卡外背景（长图边缘/导出底色） */
  shellBg: string;
  /** 推荐 font-family 链（用户未自选字体时使用） */
  recommendFont: string;
  /** 暗色模板（mermaid 渲染主题跟随） */
  dark: boolean;
  /** 是否支持拆卡 */
  paginatable: boolean;
  Frame: React.FC<FrameProps>;
}
