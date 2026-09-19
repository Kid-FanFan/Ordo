// ===== js/markdown.js =====
// 安全 Markdown 渲染：先转义后转换（沿用 v1 已验证算法，补代码块语言栏/复制钮/表格包裹）
// 红线：所有模型输出必须先转义；链接仅 http(s) 且 rel=noopener

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(src) {
  let html = "";
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let inList = false;
  let listTag = "ul";
  let tableBuf = null;

  const flushList = () => {
    if (inList) {
      html += `</${listTag}>`;
      inList = false;
    }
  };
  const flushTable = () => {
    if (tableBuf && tableBuf.length) {
      let t = '<div class="md-table-wrap"><table>';
      tableBuf.forEach((row, i) => {
        const tag = i === 0 ? "th" : "td";
        t += "<tr>" + row.map((c) => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>";
      });
      html += t + "</table></div>";
      tableBuf = null;
    }
  };
  const flushCode = () => {
    const lang = codeLang ? `<span>${escapeHtml(codeLang)}</span>` : "<span>text</span>";
    html +=
      `<div class="codeblock"><div class="cb-bar">${lang}` +
      `<button class="cb-copy" data-copy type="button">${iconCopy()}复制</button></div>` +
      `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre></div>`;
    codeBuf = [];
    codeLang = "";
  };

  for (const line of String(src).split("\n")) {
    const fence = line.trim().match(/^```(\w*)/);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushList();
        flushTable();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      (tableBuf = tableBuf || []).push(cells);
      continue;
    }
    flushTable();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushList();
      const n = h[1].length;
      html += `<h${n}>${inline(h[2])}</h${n}>`;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushList();
      html += "<hr/>";
      continue;
    }
    if (/^\s*&gt;\s?/.test(line) || /^\s*>\s?/.test(line)) {
      flushList();
      html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`;
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!inList || listTag !== tag) {
        flushList();
        html += `<${tag}>`;
        inList = true;
        listTag = tag;
      }
      html += `<li>${inline((ul || ol)[1])}</li>`;
      continue;
    }
    flushList();
    if (line.trim() === "") continue;
    html += `<p>${inline(line)}</p>`;
  }
  flushList();
  flushTable();
  if (inCode) flushCode();
  return html;
}

function iconCopy() {
  // 局部引入避免循环依赖：与 icons.js 的 copy 图标保持一致
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

// 事件委托：代码块复制按钮
export function bindMarkdownActions(root) {
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const pre = btn.closest(".codeblock")?.querySelector("pre");
    if (pre && navigator.clipboard) navigator.clipboard.writeText(pre.textContent || "");
    const old = btn.innerHTML;
    btn.textContent = "已复制";
    setTimeout(() => (btn.innerHTML = old), 1200);
  });
}
