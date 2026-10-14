export interface UINode {
  type: string;
  frame: [number, number, number, number];
  id?: string;
  label?: string;
  title?: string;
  value?: string;
  placeholder?: string;
  enabled?: boolean;
  selected?: boolean;
  children?: UINode[];
}

export interface FlatElement {
  type: string;
  id?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  enabled: boolean;
  frame: [number, number, number, number];
  center: [number, number];
  onScreen: boolean;
}

const INTERACTIVE = new Set([
  "Button", "Cell", "Link", "TextField", "SecureTextField", "TextView", "SearchField", "Switch", "Toggle",
  "Slider", "Stepper", "SegmentedControl", "Picker", "PickerWheel", "DatePicker", "Tab", "MenuItem", "Icon", "Key",
]);

function isMeaningful(n: UINode): boolean {
  return !!(n.id || n.label || n.value || n.placeholder || n.title) || INTERACTIVE.has(n.type);
}

function visible(n: UINode): boolean {
  return n.frame[2] > 0 && n.frame[3] > 0;
}

function onScreen(frame: number[], screen: number[]): boolean {
  const [x, y, w, h] = frame;
  return x + w > 0 && y + h > 0 && x < screen[2] && y < screen[3];
}

function center(frame: number[]): [number, number] {
  return [Math.round(frame[0] + frame[2] / 2), Math.round(frame[1] + frame[3] / 2)];
}

function quote(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, " ");
  return JSON.stringify(clean.length > max ? clean.slice(0, max) + "…" : clean);
}

/**
 * Render the tree as compact indented text, dropping zero-size subtrees and
 * structural wrappers that carry no label, id or interactivity.
 */
export function renderTree(root: UINode, { includeOffscreen = false } = {}): string {
  const screen = root.frame;
  const lines: string[] = [];
  const walk = (n: UINode, depth: number) => {
    const inView = onScreen(n.frame, screen);
    let childDepth = depth;
    // Zero-size wrappers can still contain visible children, so keep walking.
    if (visible(n) && isMeaningful(n) && (inView || includeOffscreen)) {
      const parts = [n.type];
      if (n.label) parts.push(quote(n.label));
      if (n.id && n.id !== n.label) parts.push(`#${n.id}`);
      if (n.value && n.value !== n.label) parts.push(`value=${quote(n.value)}`);
      if (n.placeholder) parts.push(`placeholder=${quote(n.placeholder)}`);
      const [cx, cy] = center(n.frame);
      parts.push(`@(${cx},${cy}) ${Math.round(n.frame[2])}x${Math.round(n.frame[3])}`);
      if (n.enabled === false) parts.push("[disabled]");
      if (n.selected) parts.push("[selected]");
      if (!inView) parts.push("[offscreen]");
      lines.push("  ".repeat(depth) + parts.join(" "));
      childDepth = depth + 1;
    }
    for (const c of n.children ?? []) walk(c, childDepth);
  };
  walk(root, 0);
  return lines.join("\n");
}

export function flatten(root: UINode): FlatElement[] {
  const screen = root.frame;
  const out: FlatElement[] = [];
  const walk = (n: UINode) => {
    if (visible(n)) out.push({
      type: n.type,
      id: n.id,
      label: n.label,
      value: n.value,
      placeholder: n.placeholder,
      enabled: n.enabled !== false,
      frame: n.frame,
      center: center(n.frame),
      onScreen: onScreen(n.frame, screen),
    });
    (n.children ?? []).forEach(walk);
  };
  walk(root);
  return out;
}

export interface ElementQuery {
  text?: string;
  id?: string;
  type?: string;
  index?: number;
  exact?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word match inside a short label/identifier. Long text and values are
 * excluded so a word like "About" doesn't hit a paragraph that mentions it.
 */
function partialMatch(needle: string, fields: (string | undefined)[]): boolean {
  const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}($|[^\\p{L}\\p{N}])`, "u");
  return fields.some((f) => !!f && f.length <= Math.max(needle.length * 3, 40) && word.test(f.toLowerCase()));
}

/** Find elements matching a query; exact text matches rank above partial ones. */
export function findElements(root: UINode, q: ElementQuery): FlatElement[] {
  const needle = q.text?.toLowerCase();
  const scored: { el: FlatElement; score: number }[] = [];
  for (const el of flatten(root)) {
    if (q.type && el.type.toLowerCase() !== q.type.toLowerCase()) continue;
    if (q.id && el.id !== q.id) continue;
    let score = 1;
    if (needle) {
      const fields = [el.label, el.id, el.value, el.placeholder].filter(Boolean).map((s) => s!.toLowerCase());
      if (fields.some((f) => f === needle)) score = 3;
      else if (!q.exact && partialMatch(needle, [el.label, el.id, el.placeholder])) score = 2;
      else continue;
    }
    if (el.onScreen) score += 0.5;
    if (isMeaningful(el as UINode)) score += 0.25;
    scored.push({ el, score });
  }
  // Prefer deeper (later) elements on ties: the innermost match is usually the control itself.
  return scored
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .map((s) => s.el);
}

export function describeElement(el: FlatElement): string {
  const name = el.label ?? el.id ?? el.value ?? el.placeholder ?? "";
  return `${el.type}${name ? " " + quote(name) : ""} @(${el.center[0]},${el.center[1]})`;
}
