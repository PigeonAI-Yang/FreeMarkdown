import type { CardTemplate, FrameProps } from "./types";
import "./notion-clean.css";

/** 卡内装饰：仅保留「导出自 FreeMarkdown」页脚 */
function NotionCleanFrame({ children }: FrameProps) {
  return (
    <div className="tpl-nc-frame">
      {children}
      <footer className="tpl-nc-footer">导出自 FreeMarkdown</footer>
    </div>
  );
}

/** Notion 简约模板：白底黑白灰、红色行内代码 */
export const notionCleanTemplate: CardTemplate = {
  id: "notion-clean",
  name: "Notion 简约",
  width: 720,
  aspect: "free",
  contentClass: "tpl-notion-clean",
  shellBg: "#f7f7f5",
  recommendFont:
    'ui-sans-serif,"Segoe UI","Microsoft YaHei",sans-serif',
  dark: false,
  paginatable: true,
  Frame: NotionCleanFrame,
};

export default notionCleanTemplate;
