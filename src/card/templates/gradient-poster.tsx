import type { CardTemplate, FrameProps } from "./types";
import "./gradient-poster.css";

/** 卡内装饰：顶部文档名小字眉标 + 底部品牌页脚 */
function GradientPosterFrame({ ctx, children }: FrameProps) {
  return (
    <div className="tpl-gp-frame">
      <header className="tpl-gp-kicker">{ctx.docTitle}</header>
      {children}
      <footer className="tpl-gp-footer">
        <span className="tpl-gp-brand">FreeMarkdown</span>
      </footer>
    </div>
  );
}

/** 靛紫海报模板：深靛渐变底、白字、青紫点缀 */
export const gradientPosterTemplate: CardTemplate = {
  id: "gradient-poster",
  name: "靛紫海报",
  width: 720,
  aspect: "free",
  contentClass: "tpl-gradient-poster",
  shellBg: "#1a1b3a",
  recommendFont:
    '"Segoe UI Variable Display","Segoe UI","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif',
  dark: true,
  paginatable: true,
  Frame: GradientPosterFrame,
};

export default gradientPosterTemplate;
