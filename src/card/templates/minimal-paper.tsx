import type { CardTemplate, FrameProps } from "./types";
import "./minimal-paper.css";

/** 卡内装饰：底部细线 + 细页码 */
function MinimalPaperFrame({ ctx, children }: FrameProps) {
  return (
    <div className="tpl-min-frame">
      {children}
      <footer className="tpl-min-footer">
        <span className="tpl-min-page">
          {ctx.pageCount > 1
            ? `${ctx.pageIndex + 1} / ${ctx.pageCount}`
            : `${ctx.pageIndex + 1}`}
        </span>
      </footer>
    </div>
  );
}

/** 极简纸模板：纯白大边距、细页码页脚 */
export const minimalPaperTemplate: CardTemplate = {
  id: "minimal-paper",
  name: "极简纸",
  width: 720,
  aspect: "free",
  contentClass: "tpl-minimal-paper",
  shellBg: "#f2f2f2",
  recommendFont: 'Inter,"Segoe UI","Microsoft YaHei",sans-serif',
  dark: false,
  paginatable: true,
  Frame: MinimalPaperFrame,
};

export default minimalPaperTemplate;
