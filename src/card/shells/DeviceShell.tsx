import type { JSX, ReactNode } from "react";
import type { ShellKind } from "../templates/types";
import "./shells.css";

interface DeviceShellProps {
  kind: ShellKind;
  title: string;
  /**
   * 模板主题类：挂到「屏幕」层，让模板的纸面底色/纹理与留白落在屏幕内部。
   * 不传时屏幕用自身白底。
   */
  contentClass?: string;
  children: ReactNode;
}

/**
 * 设备外壳：none 透明内衬 / iPhone 灵动机壳 / macOS 窗口条。
 * 外框宽度随父容器（模板纸边内内容盒）填满，不硬定宽——
 * 硬定模板 width 会叠加模板 padding 造成横向溢出（内容被削边）。
 * 视觉细节见 shells.css（.dshell- 前缀）。
 */
export function DeviceShell(props: DeviceShellProps): JSX.Element {
  const { kind, title, contentClass, children } = props;
  /* 模板主题类挂到「内容区」：纸面底色/纹理与留白落在屏幕内部；
     状态栏与 home 条保持整宽白底，不参与模板留白。 */
  const contentCls = `dshell-content${contentClass ? ` ${contentClass}` : ""}`;

  if (kind === "iphone") {
    return (
      <div className="dshell dshell-iphone">
        <div className="dshell-screen">
          <div className="dshell-statusbar">
            <span className="dshell-statusbar-time">9:41</span>
            <span className="dshell-island" aria-hidden="true" />
            <span className="dshell-statusbar-icons" aria-hidden="true">
              <span className="dshell-signal">
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="dshell-wifi" />
              <span className="dshell-battery">
                <span className="dshell-battery-body" />
                <span className="dshell-battery-cap" />
              </span>
            </span>
          </div>
          <div className={contentCls}>{children}</div>
          <div className="dshell-homebar-row">
            <span className="dshell-homebar" aria-hidden="true" />
          </div>
        </div>
      </div>
    );
  }

  if (kind === "macos") {
    return (
      <div className="dshell dshell-macos">
        <div className="dshell-titlebar">
          <span className="dshell-dots" aria-hidden="true">
            <span className="dshell-dot dshell-dot-close" />
            <span className="dshell-dot dshell-dot-min" />
            <span className="dshell-dot dshell-dot-max" />
          </span>
          <span className="dshell-titlebar-text">{title}</span>
          <span className="dshell-titlebar-pad" aria-hidden="true" />
        </div>
        <div className={contentCls}>{children}</div>
      </div>
    );
  }

  return (
    <div className="dshell dshell-none">{children}</div>
  );
}

export default DeviceShell;
