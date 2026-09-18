import type { CardTemplate, FrameProps } from "./types";
import "./terminal.css";

/** 卡内装饰：顶部窗口圆点 + 底部「~/freemardown — 文档名」提示符页脚 */
function TerminalFrame({ ctx, children }: FrameProps) {
  return (
    <div className="tpl-term-frame">
      <div className="tpl-term-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      {children}
      <footer className="tpl-term-footer">
        <span className="tpl-term-path">~/freemardown</span>
        <span className="tpl-term-sep"> — </span>
        <span className="tpl-term-doc">{ctx.docTitle}</span>
      </footer>
    </div>
  );
}

/** 终端模板：深色等宽、绿色强调、提示符页脚 */
export const terminalTemplate: CardTemplate = {
  id: "terminal",
  name: "终端",
  width: 720,
  aspect: "free",
  contentClass: "tpl-terminal",
  shellBg: "#010409",
  recommendFont: '"Cascadia Code","Cascadia Mono",Consolas,monospace',
  dark: true,
  paginatable: true,
  Frame: TerminalFrame,
};

export default terminalTemplate;
