import type { CardTemplate } from "./types";
import { appleNotesTemplate } from "./apple-notes";
import { xhsKnowledgeTemplate } from "./xhs-knowledge";
import { wechatArticleTemplate } from "./wechat-article";
import { terminalTemplate } from "./terminal";
import { minimalPaperTemplate } from "./minimal-paper";
import { gradientPosterTemplate } from "./gradient-poster";
import { vintagePaperTemplate } from "./vintage-paper";
import { notionCleanTemplate } from "./notion-clean";

/** 全部内置模板（按文档顺序） */
export const TEMPLATES: CardTemplate[] = [
  appleNotesTemplate,
  xhsKnowledgeTemplate,
  wechatArticleTemplate,
  terminalTemplate,
  minimalPaperTemplate,
  gradientPosterTemplate,
  vintagePaperTemplate,
  notionCleanTemplate,
];

export const DEFAULT_TEMPLATE_ID = "apple-notes";

/** 按 id 取模板，找不到回退默认 */
export function getTemplate(id: string): CardTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? appleNotesTemplate;
}
