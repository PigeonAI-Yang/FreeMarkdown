// 抓取一次页面刷新前后的控制台 [restore] 日志
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime, Page } = client;
await Runtime.enable(); await Page.enable();
const logs = [];
Runtime.consoleAPICalled((e) => {
  const text = e.args.map(a => a.value ?? a.description ?? "").join(" ");
  if (text.includes("[restore]")) logs.push(`${e.type}: ${text}`);
});
await Page.reload({ ignoreCache: true });
await new Promise(r => setTimeout(r, 6000));
console.log(logs.join("\n") || "NO RESTORE LOGS");
client.close();
