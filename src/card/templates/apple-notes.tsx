import type { CardTemplate, FrameProps } from "./types";
import "./apple-notes.css";

/** 格式化为「2026年9月18日 星期五」 */
function formatZhDate(d: Date): string {
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}

/** 卡内装饰：顶部灰色日期行，无页脚（极简） */
function AppleNotesFrame({ children }: FrameProps) {
  return (
    <div className="tpl-apple-frame">
      <div className="tpl-apple-date">{formatZhDate(new Date())}</div>
      {children}
    </div>
  );
}

/** 苹果备忘录模板：白底卡、黄色标题高亮带 */
export const appleNotesTemplate: CardTemplate = {
  id: "apple-notes",
  name: "苹果备忘录",
  width: 720,
  aspect: "free",
  contentClass: "tpl-apple-notes",
  shellBg: "#f5f5f7",
  recommendFont:
    '"SF Pro Display","Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif',
  dark: false,
  paginatable: true,
  Frame: AppleNotesFrame,
};

export default appleNotesTemplate;
