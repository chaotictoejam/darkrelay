/**
 * A DOM stand-in for the views. The dashboard draws with document.createElement
 * and nothing else, so a few dozen lines of object cover every page — and the
 * tests can read back the text a person would see without a browser.
 */

/**
 * Deliberately untyped: this stands in for a DOM element, and spelling out
 * the handful of properties the views touch would only be a second, weaker
 * copy of lib.dom.
 */
export type Node = any;

/** Enough of an element for the view code: children, text, and tables. */
export function createElement(tag: string): Node {
  const node: Node = {
    tag,
    children: [] as Node[],
    _text: '',
    className: '',
    style: {},
    attrs: {} as Record<string, string>,
    append: (...kids: Node[]) => node.children.push(...kids),
    prepend: (...kids: Node[]) => node.children.unshift(...kids),
    replaceChildren: (...kids: Node[]) => {
      node.children = kids;
      node._text = '';
    },
    setAttribute: (k: string, v: string) => {
      node.attrs[k] = v;
    },
    getAttribute: (k: string) => node.attrs[k],
    addEventListener: (name: string, fn: () => void) => {
      node.handlers = { ...(node.handlers ?? {}), [name]: fn };
    },
    classList: { add: () => {}, remove: () => {} },
    focus: () => {},
    remove: () => {},
    createTHead: () => push(node, createElement('thead')),
    createTBody: () => push(node, createElement('tbody')),
    insertRow: () => push(node, createElement('tr')),
    insertCell: () => push(node, createElement('td')),
    get firstElementChild() {
      return node.children[0];
    },
    get lastElementChild() {
      return node.children[node.children.length - 1];
    },
  };
  Object.defineProperty(node, 'textContent', {
    get: () => node._text,
    set: (value: string) => {
      node._text = String(value ?? '');
      node.children = [];
    },
  });
  return node;
}

function push(parent: Node, child: Node): Node {
  parent.children.push(child);
  return child;
}

/** Every bit of text the tree would show, in order. */
export function text(node: Node): string {
  if (typeof node === 'string') return node;
  return [node._text, ...node.children.map(text)].filter(Boolean).join(' ');
}

export function find(node: Node, predicate: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (typeof node === 'string') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children) find(child, predicate, out);
  return out;
}

/**
 * The globals a page needs to draw: `document`, and the ResizeObserver the
 * charts measure themselves with. Observing is a no-op, so a chart stays
 * unmeasured and unpainted — which is the right amount of chart for a test
 * about the text around it.
 */
export function installDom() {
  const globals = globalThis as Record<string, unknown>;
  globals['document'] = {
    createElement,
    createElementNS: (_ns: string, tag: string) => createElement(tag),
  };
  globals['ResizeObserver'] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
