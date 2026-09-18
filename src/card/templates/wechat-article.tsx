import type { CardTemplate, FrameProps } from "./types";
import "./wechat-article.css";

/** 卡内装饰：仅保留「END」页脚（公众号式收尾） */
function WechatArticleFrame({ children }: FrameProps) {
  return (
    <div className="tpl-wechat-frame">
      {children}
      <footer className="tpl-wechat-footer">
        <span className="tpl-wechat-end">END</span>
      </footer>
    </div>
  );
}

/** 公众号文章模板：米白衬线正文、居中标题带下划细线 */
export const wechatArticleTemplate: CardTemplate = {
  id: "wechat-article",
  name: "公众号文章",
  width: 720,
  aspect: "free",
  contentClass: "tpl-wechat-article",
  shellBg: "#ececec",
  recommendFont: '"Georgia","Noto Serif SC","Source Han Serif SC","SimSun",serif',
  dark: false,
  paginatable: true,
  Frame: WechatArticleFrame,
};

export default wechatArticleTemplate;
