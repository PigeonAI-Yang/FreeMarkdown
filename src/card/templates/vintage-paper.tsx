import type { CardTemplate, FrameProps } from "./types";
import "./vintage-paper.css";

/** 卡内装饰：顶部「❖」饰线眉标 + 底部品牌页脚 */
function VintagePaperFrame({ children }: FrameProps) {
  return (
    <div className="tpl-vp-frame">
      <header className="tpl-vp-ornament" aria-hidden="true">
        ❖
      </header>
      {children}
      <footer className="tpl-vp-footer">
        <span className="tpl-vp-brand">· FreeMarkdown ·</span>
      </footer>
    </div>
  );
}

/** 复古纸张模板：米黄细横纹纸面、深棕衬线、居中标题 */
export const vintagePaperTemplate: CardTemplate = {
  id: "vintage-paper",
  name: "复古纸张",
  width: 720,
  aspect: "free",
  contentClass: "tpl-vintage-paper",
  shellBg: "#efe4cc",
  recommendFont: '"Georgia","Noto Serif SC","Source Han Serif SC","SimSun",serif',
  dark: false,
  paginatable: true,
  Frame: VintagePaperFrame,
};

export default vintagePaperTemplate;
