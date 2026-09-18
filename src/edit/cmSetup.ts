import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

/**
 * CodeMirror 6 装配：只做「输入」这件事。
 *
 * 预览不走 CM6 的渲染，所以这里不引入任何 WYSIWYG 相关扩展；
 * 主题色全部走 CSS 变量（app.css 的 --ed-*），跟随明暗主题切换。
 */

/** 语法高亮：Markdown 标记弱化，正文与标题保持可读 */
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--ed-heading)", fontWeight: "650" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--text-3)" },
  { tag: t.monospace, color: "var(--ed-code)" },
  { tag: t.quote, color: "var(--text-2)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // 标记符号（# * ` > - 等）：压低对比度，让文字本身突出
  { tag: t.processingInstruction, color: "var(--ed-mark)" },
  { tag: t.contentSeparator, color: "var(--ed-mark)" },
  { tag: t.list, color: "var(--ed-mark)" },
  { tag: t.labelName, color: "var(--ed-mark)" },
  { tag: t.keyword, color: "var(--ed-code)" },
  { tag: t.string, color: "var(--ed-string)" },
  { tag: t.number, color: "var(--ed-string)" },
  { tag: t.comment, color: "var(--text-3)" },
]);

const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--ed-bg)",
    color: "var(--text-1)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.7",
    overflow: "auto",
  },
  ".cm-content": { padding: "10px 0 40vh", caretColor: "var(--ed-caret)" },
  ".cm-line": { padding: "0 12px 0 6px" },
  ".cm-gutters": {
    backgroundColor: "var(--ed-gutter-bg)",
    color: "var(--ed-gutter-fg)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "var(--ed-active-line)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--ed-active-line)",
    color: "var(--text-2)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ed-caret)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--ed-match)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--ed-match-sel)" },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-elev)",
    border: "1px solid var(--border)",
    color: "var(--text-1)",
  },
});

export interface EditorHooks {
  /** 文档变化（不含纯选区移动） */
  onChange: () => void;
  onSave: () => void;
  /** 编辑器失焦（用于立即落盘） */
  onBlur?: () => void;
  /** 选区变化（点击/方向键移动光标；用于驱动预览跟随） */
  onSelection?: () => void;
}

export function editorExtensions(hooks: EditorHooks): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(mdHighlight),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    markdown(),
    baseTheme,
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          hooks.onSave();
          return true;
        },
      },
      ...markdownKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange();
      // 选区变化（且不是文档改动带来的）：光标移动 / 点击定位 → 预览跟随
      if (u.selectionSet && !u.docChanged && u.view.hasFocus) hooks.onSelection?.();
      if (u.focusChanged && !u.view.hasFocus && hooks.onBlur) hooks.onBlur();
    }),
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocapitalize: "off",
      autocomplete: "off",
      "aria-label": "Markdown 源码",
    }),
  ];
}

/** 创建编辑状态：优先用冻结快照恢复（保住光标、选区、撤销历史） */
export function createEditorState(
  doc: string,
  extensions: Extension[],
  stateJSON?: unknown,
): EditorState {
  if (stateJSON) {
    try {
      return EditorState.fromJSON(stateJSON, { extensions });
    } catch {
      // 快照与当前扩展不兼容：退回纯文本
    }
  }
  return EditorState.create({ doc, extensions });
}
