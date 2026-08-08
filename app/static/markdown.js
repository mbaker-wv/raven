function _mdEscapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function _mdInline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

const _MD_HEADING = /^(#{1,6})\s+(.*)$/;
const _MD_BULLET = /^[-*•]\s+/;
const _MD_NUMBERED = /^\d+[.)]\s+/;
const _MD_TABLE_SEP = /^[\s|:-]*-[\s|:-]*$/;

function _splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function _mdRenderLines(lines) {
  const parts = [];
  let i = 0;
  while (i < lines.length) {
    const heading = lines[i].match(_MD_HEADING);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // keep below the page's own h1/h2
      parts.push(`<h${level}>${_mdInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (lines[i].includes("|") && i + 1 < lines.length && _MD_TABLE_SEP.test(lines[i + 1])) {
      const headerCells = _splitTableRow(lines[i]);
      i += 2; // header row + separator row
      const bodyRows = [];
      while (i < lines.length && lines[i].includes("|") && !_MD_HEADING.test(lines[i])) {
        bodyRows.push(_splitTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${_mdInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${_mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      parts.push(`<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`);
      continue;
    }

    if (_MD_BULLET.test(lines[i])) {
      const items = [];
      while (i < lines.length && _MD_BULLET.test(lines[i])) {
        items.push(`<li>${_mdInline(lines[i].replace(_MD_BULLET, ""))}</li>`);
        i++;
      }
      parts.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (_MD_NUMBERED.test(lines[i])) {
      const items = [];
      while (i < lines.length && _MD_NUMBERED.test(lines[i])) {
        items.push(`<li>${_mdInline(lines[i].replace(_MD_NUMBERED, ""))}</li>`);
        i++;
      }
      parts.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paraLines = [];
    while (i < lines.length && !_MD_HEADING.test(lines[i]) && !_MD_BULLET.test(lines[i]) && !_MD_NUMBERED.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    parts.push(`<p>${paraLines.map(_mdInline).join("<br>")}</p>`);
  }
  return parts.join("");
}

function renderMarkdown(raw) {
  if (!raw) return "";
  const escaped = _mdEscapeHtml(raw).replace(/\r\n/g, "\n");
  const blocks = escaped
    .split(/\n{2,}/)
    .map((block) => block.split("\n").filter((l) => l.trim() !== ""))
    .filter((lines) => lines.length > 0);
  if (blocks.length === 0) return "";
  return blocks.map(_mdRenderLines).join("");
}
