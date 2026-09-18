import { useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { EditView } from "./EditView";
import { claimEditPath, releaseEditPathNow, scheduleReleaseEditPath } from "./editSessions";

interface EditParams {
  path: string;
}

/**
 * dockview 面板组件（`edit:` 前缀）。不可见时冻结：卸载 EditView（CM6 实例与
 * 全部 DOM 都不挂），缓冲区与光标留在 editSessions，重新可见时恢复。
 */
export function EditPane(props: IDockviewPanelProps<EditParams>) {
  const [visible, setVisible] = useState(props.api.isVisible);
  const path = props.params.path;

  useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  useEffect(() => {
    claimEditPath(path);
    return () => {
      releaseEditPathNow(path);
      scheduleReleaseEditPath(path);
    };
  }, [path]);

  if (!visible) {
    return <div className="frozen-placeholder" />;
  }
  return (
    <EditView
      key={path}
      path={path}
      isActive={() => props.api.isActive}
      onRequestClose={() => props.api.close()}
    />
  );
}
