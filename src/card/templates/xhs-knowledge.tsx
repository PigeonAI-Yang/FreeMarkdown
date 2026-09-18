import type { CardTemplate, FrameProps } from "./types";
import "./xhs-knowledge.css";

/** 卡内装饰：顶部「知识卡片」胶囊 + 底部页码与品牌页脚 */
function XhsKnowledgeFrame({ ctx, children }: FrameProps) {
  return (
    <div className="tpl-xhs-frame">
      <div className="tpl-xhs-badge">知识卡片</div>
      {children}
      <footer className="tpl-xhs-footer">
        <span className="tpl-xhs-brand">· FreeMarkdown ·</span>
        <span className="tpl-xhs-page">
          {ctx.pageIndex + 1} / {ctx.pageCount}
        </span>
        <span className="tpl-xhs-brand">· FreeMarkdown ·</span>
      </footer>
    </div>
  );
}

/** 小红书知识卡模板：3:4 固定比例、暖白底、红色点缀 */
export const xhsKnowledgeTemplate: CardTemplate = {
  id: "xhs-knowledge",
  name: "小红书知识卡",
  width: 390,
  aspect: "3:4",
  contentClass: "tpl-xhs-knowledge",
  shellBg: "#f6ede0",
  recommendFont:
    '"PingFang SC","HarmonyOS Sans SC","MiSans","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif',
  dark: false,
  paginatable: true,
  Frame: XhsKnowledgeFrame,
};

export default xhsKnowledgeTemplate;
