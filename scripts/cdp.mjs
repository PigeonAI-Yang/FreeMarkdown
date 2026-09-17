// CDP 验收驱动：连接 WebView2 远程调试端口，驱动真实应用窗口做检查与截图。
//   node scripts/cdp.mjs <命令>
// 命令：
//   state                     —— 打印应用基础状态（booted/panels/console 错误）
//   open <路径>               —— 通过 __fm.openFile 打开文档
//   folder <路径>             —— 设置根目录
//   check                     —— 运行渲染断言（TOC/KaTeX/mermaid/高亮/任务列表）
//   shot <输出.png>           —— 截图
//   eval <js>                 —— 评估任意 JS
import CDP from "chrome-remote-interface";

const port = process.env.CDP_PORT || 9223;

async function withTab(fn) {
  const client = await CDP({ port, wait: true });
  const { Runtime, Page, Log } = client;
  const errors = [];
  Log.enable().catch(() => {});
  Runtime.enable().catch(() => {});
  Log.entryAdded((e) => {
    if (e.entry.level === "error") errors.push(e.entry.text);
  });
  Runtime.exceptionThrown((e) => errors.push(e.exceptionDetails?.text ?? "exception"));
  await fn({ Runtime, Page, errors }).finally(() => client.close());
}

async function evalJs(Runtime, expr) {
  const r = await Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  }
  return r.result.value;
}

const cmd = process.argv[2];
const arg = process.argv[3];

await withTab(async ({ Runtime, Page, errors }) => {
  switch (cmd) {
    case "state": {
      const s = await evalJs(
        Runtime,
        `(() => ({
          booted: !!document.querySelector("header"),
          title: document.title,
          tabs: [...document.querySelectorAll(".dockview-view, [class*='tab']")].length,
          bodyLen: document.body.innerHTML.length,
        }))()`,
      );
      console.log(JSON.stringify(s, null, 1));
      console.log("console-errors:", JSON.stringify(errors.slice(0, 10)));
      break;
    }
    case "open": {
      const res = await evalJs(
        Runtime,
        `(async () => {
          const t0 = performance.now();
          window.__fm.openFile(${JSON.stringify(arg)});
          for (let i = 0; i < 200; i++) {
            await new Promise(r => setTimeout(r, 50));
            const el = document.querySelector(".doc-content");
            if (el && el.innerHTML.length > 100) break;
          }
          return { ms: Math.round(performance.now() - t0), injected: !!document.querySelector(".doc-content") };
        })()`,
      );
      console.log(JSON.stringify(res));
      break;
    }
    case "folder": {
      await evalJs(Runtime, `window.__fm.setRootFolder(${JSON.stringify(arg)}), 1`);
      console.log("root set:", arg);
      break;
    }
    case "check": {
      const s = await evalJs(
        Runtime,
        `(() => {
          const q = (sel) => document.querySelectorAll(sel).length;
          return {
            headings: q(".doc-content h1[id], .doc-content h2[id]"),
            tocItems: q("[data-toc-id]"),
            codeHighlighted: q(".doc-content code .hljs-keyword, .doc-content code span[class^='hljs']"),
            katex: q(".doc-content .katex"),
            katexErrors: q(".doc-content .katex-error"),
            mermaidSvg: q(".doc-content .mermaid-host svg"),
            mermaidError: q(".doc-content .mermaid-error"),
            taskCheckbox: q(".doc-content input[type='checkbox']"),
            tables: q(".doc-content table"),
            footnotes: q(".doc-content .footnotes"),
            del: q(".doc-content del"),
            images: q(".doc-content img"),
            docChars: document.querySelector(".doc-content")?.textContent.length ?? 0,
          };
        })()`,
      );
      console.log(JSON.stringify(s, null, 1));
      console.log("console-errors:", JSON.stringify(errors.slice(0, 10)));
      break;
    }
    case "shot": {
      await Page.enable();
      const { data } = await Page.captureScreenshot({ format: "png" });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(arg, Buffer.from(data, "base64"));
      console.log("saved", arg);
      break;
    }
    case "eval": {
      console.log(JSON.stringify(await evalJs(Runtime, arg)));
      break;
    }
    default:
      console.log("unknown command");
  }
});
