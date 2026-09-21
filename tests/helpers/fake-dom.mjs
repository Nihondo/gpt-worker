// A just-enough DOM to run the dashboard's browser modules (common-app.js and
// workspace-panel.js) under plain Node — no jsdom, matching the project's
// zero-dependency rule. It supports exactly what those modules use: elements
// with children/textContent/attributes/listeners, getElementById (creating on
// demand), createElement, one querySelector, and classList/hidden/value/checked.
//
// It also ENFORCES the dashboard's rendering rule: untrusted text reaches the
// page only through textContent. Assigning innerHTML/outerHTML or calling
// insertAdjacentHTML throws, so a test that renders attacker-shaped text fails
// loudly if the code under test ever tries to interpret it as markup.

class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.className = "";
    this.value = "";
    this.checked = false;
    this.type = "";
    this._text = "";
    const self = this;
    this.classList = {
      add(name) { if (!self.hasClass(name)) self.className = (self.className + " " + name).trim(); },
      remove(name) { self.className = self.className.split(/\s+/).filter((c) => c && c !== name).join(" "); },
      contains(name) { return self.hasClass(name); },
    };
  }
  hasClass(name) { return this.className.split(/\s+/).includes(name); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); }
  dispatch(type) { (this.listeners[type] || []).forEach((listener) => listener({ type, target: this })); }
  click() { this.dispatch("click"); }
  focus() { FakeElement.focused = this; }
  set innerHTML(_value) { throw new Error("innerHTML is forbidden: untrusted text must go through textContent"); }
  set outerHTML(_value) { throw new Error("outerHTML is forbidden"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML is forbidden"); }
}

export function createFakeDom() {
  const byId = new Map();
  const threePane = new FakeElement("div");
  threePane.className = "three-pane";
  FakeElement.focused = null;
  const document = {
    hidden: false,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeElement("div", id));
      return byId.get(id);
    },
    createElement: (tag) => new FakeElement(tag),
    querySelector: (selector) => (selector === ".three-pane" ? threePane : null),
  };
  return { document, byId, threePane, focused: () => FakeElement.focused };
}

/** Every descendant of `root` (depth-first), including `root`. */
export function descendants(root) {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

/** The descendants of `root` that carry `className` as one of their classes. */
export function withClass(root, className) {
  return descendants(root).filter((node) => node.hasClass(className));
}
