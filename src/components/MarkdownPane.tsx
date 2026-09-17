import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { MarkdownView, chunkHtmlCache } from "./MarkdownView";
import { jumpRegistry } from "../lib/store";

/**
 * dockview 面板组件。隐藏标签页（isVisible=false）时冻结：
 * 不挂载正文 DOM，滚动位置保留在 scrollMap，重新可见时恢复。
 */
export function MarkdownPane(props: IDockviewPanelProps<{ path: string }>) {
  const [visible, setVisible] = useState(props.api.isVisible);
  const [path, setPath] = useState(props.params.path);

  useEffect(() => {
    const disp1 = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => {
      disp1.dispose();
    };
  }, [props.api]);

  // 面板关闭（本组件卸载）时清理该文档的内存缓存
  useEffect(() => {
    const p = path;
    return () => {
      chunkHtmlCache.delete(p);
      jumpRegistry.delete(p);
    };
  }, [path]);

  if (!visible) {
    return <div className="frozen-placeholder" />;
  }
  return <MarkdownView key={path} path={path} />;
}
