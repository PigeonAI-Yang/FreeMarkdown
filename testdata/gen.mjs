// 生成性能测试数据：
//   node testdata/gen.mjs
//   - testdata/big/big{1..4}.md  各约 2MB（4 窗格测试）
//   - testdata/big/one-mb.md     约 1.2MB（大文档打开测试）
//   - testdata/many/note-*.md    1200 个小文件（搜索基准，部分含关键词）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const bigDir = join(root, "big");
const manyDir = join(root, "many");
mkdirSync(bigDir, { recursive: true });
mkdirSync(manyDir, { recursive: true });

const WORDS =
  "本地阅读器性能测试正文段落：comrak 在后台线程解析 Markdown，WebView 只负责注入 HTML 字符串。分层虚拟滚动只挂载可视区分块，未激活窗格冻结渲染不保留 DOM。FTK8 关键词出现在部分段落中用于搜索命中验证。布局由 dockview 管理支持拖拽分屏与标签分组，会话退出时保存现场，启动直接恢复。".split(
    /(?<=。)/,
  );

function para(i) {
  return WORDS.slice(i % WORDS.length)
    .concat(WORDS[(i + 2) % WORDS.length])
    .join("");
}

function codeBlock(i) {
  return [
    "```rust",
    `// sample ${i}`,
    `fn process_${i}(input: &str) -> Result<String, Error> {`,
    `    let parsed = input.trim().parse::<u64>()?;`,
    `    Ok(format!("parsed = {parsed}"))`,
    `}`,
    "```",
  ].join("\n");
}

function table(i) {
  const rows = [];
  rows.push("| 列A | 列B | 列C |");
  rows.push("| --- | --- | --- |");
  for (let r = 0; r < 4; r++) {
    rows.push(`| ${i}-${r}a | 值 ${r} | ${r * 7} |`);
  }
  return rows.join("\n");
}

/**
 * 生成一篇约 targetBytes 的文档：
 * 每节 = h2 标题 + 若干段落 + 偶尔代码块/表格
 */
function makeDoc(targetBytes, seed) {
  const parts = [`# 性能测试文档 ${seed}`, ""];
  let section = 0;
  const push = (...items) => {
    for (const it of items) {
      parts.push(it);
      parts.push("");
    }
  };
  while (Buffer.byteLength(parts.join("\n"), "utf8") < targetBytes) {
    section++;
    push(`## 第 ${section} 节`);
    push(para(section + seed));
    if (section % 3 === 0) push(codeBlock(section));
    if (section % 5 === 0) push(table(section));
    if (section % 7 === 0) push("- 列表项甲\n- 列表项乙\n- 列表项丙");
  }
  return parts.join("\n");
}

for (let i = 1; i <= 4; i++) {
  const p = join(bigDir, `big${i}.md`);
  writeFileSync(p, makeDoc(2 * 1024 * 1024, i * 101));
  console.log("wrote", p);
}
writeFileSync(join(bigDir, "one-mb.md"), makeDoc(1200 * 1024, 999));
console.log("wrote one-mb.md");

// 1200 个小文件，其中每 10 个含 1 个 "FTK8"
for (let i = 0; i < 1200; i++) {
  const hit = i % 10 === 3;
  const body = [
    `# 笔记 ${i}`,
    "",
    para(i),
    "",
    hit ? "这一段包含特殊标记 FTK8 用于搜索验证，位置在第 5 行附近。" : "普通段落，没有特殊标记。",
    "",
    para(i + 7),
  ].join("\n");
  writeFileSync(join(manyDir, `note-${String(i).padStart(4, "0")}.md`), body);
}
console.log("wrote 1200 notes");
