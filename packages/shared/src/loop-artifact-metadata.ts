/** 只解析有界 Markdown 元信息，不执行 YAML 标签或访问文件；第三方许可见 THIRD_PARTY_NOTICES.md。 */
export interface ArtifactMeta {
  type?: string;
  title?: string;
  date?: string;
}

const MAX_BLOCK_BYTES = 8 * 1024;

const MAX_VALUE_LEN = 500;

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function unquote(v: string): string {
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  }
  return v;
}

/** 有界解析顶层标量，返回元信息；缺少结束标记时不猜测。 */
export function parseFrontMatter(content: string): Record<string, string> | null {
  if (typeof content !== "string") return null;

  let text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  const openMatch = /^---[ \t]*\r?\n/.exec(text);
  if (!openMatch) return null;


  const region = text.slice(openMatch[0].length, openMatch[0].length + MAX_BLOCK_BYTES);
  const lines = region.split("\n");

  const out: Record<string, string> = {};
  let closed = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");

    if (/^---[ \t]*$/.test(line)) {
      closed = true;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;

    if (/^\s/.test(line)) continue;
    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(colon + 1).trim();
    if (!value) continue;
    value = unquote(value).slice(0, MAX_VALUE_LEN);
    if (!value) continue;
    if (!(key in out)) out[key] = value;
  }

  if (!closed) return null;
  return Object.keys(out).length ? out : null;
}

/** 有界解析顶层标量，返回元信息；缺少结束标记时不猜测。 */
export function artifactMeta(content: string): ArtifactMeta | null {
  const fm = parseFrontMatter(content);
  if (!fm) return null;
  const meta: ArtifactMeta = {};
  if (fm.type) meta.type = fm.type;
  if (fm.title) meta.title = fm.title;
  if (fm.date) meta.date = fm.date;
  return Object.keys(meta).length ? meta : null;
}
