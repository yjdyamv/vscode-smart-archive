/**
 * v-tip — VS Code-style tooltip.
 *
 * Native `title` tooltips cannot be styled, so this directive renders a
 * singleton popup that follows the cursor and is themed with the editor
 * hover-widget tokens (--vscode-editorHoverWidget-*), matching the look of
 * VS Code's own tooltips. Content is set via textContent — never HTML.
 */

import type { Directive } from "vue";

const SHOW_DELAY = 180;
const OFFSET_X = 12;
const OFFSET_Y = 20;
const EDGE_PAD = 8;

let tipEl: HTMLDivElement | null = null;
let shown = false;

function getEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "sa-tip";
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function place(x: number, y: number): void {
  const el = getEl();
  el.style.left = "0px";
  el.style.top = "0px";
  const rect = el.getBoundingClientRect();
  let left = x + OFFSET_X;
  let top = y + OFFSET_Y;
  if (left + rect.width + EDGE_PAD > window.innerWidth) left = x - rect.width - OFFSET_X;
  if (top + rect.height + EDGE_PAD > window.innerHeight) top = y - rect.height - OFFSET_Y;
  left = Math.max(EDGE_PAD, Math.min(left, window.innerWidth - rect.width - EDGE_PAD));
  top = Math.max(EDGE_PAD, Math.min(top, window.innerHeight - rect.height - EDGE_PAD));
  el.style.left = left + "px";
  el.style.top = top + "px";
}

function show(text: string, x: number, y: number): void {
  const el = getEl();
  el.textContent = text;
  place(x, y);
  if (!shown) {
    shown = true;
    void el.offsetHeight;
    el.classList.add("show");
  }
}

function hide(): void {
  if (!shown) return;
  shown = false;
  getEl().classList.remove("show");
}

function attach(el: HTMLElement): { set: (text: string) => void; dispose: () => void } {
  let text = "";
  let timer: number | undefined;
  let anchorX = 0;
  let anchorY = 0;

  const onEnter = (e: MouseEvent) => {
    anchorX = e.clientX;
    anchorY = e.clientY;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => show(text, anchorX, anchorY), SHOW_DELAY);
  };
  const onMove = (e: MouseEvent) => {
    anchorX = e.clientX;
    anchorY = e.clientY;
    if (shown) place(anchorX, anchorY);
  };
  const onLeave = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    hide();
  };
  const onFocus = () => {
    const r = el.getBoundingClientRect();
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => show(text, r.left + r.width / 2, r.bottom), SHOW_DELAY);
  };
  const onBlur = () => onLeave();

  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mousemove", onMove);
  el.addEventListener("mouseleave", onLeave);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);

  return {
    set: (v: string) => {
      text = v;
      if (shown) getEl().textContent = v;
    },
    dispose: () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
      if (timer !== undefined) window.clearTimeout(timer);
      hide();
    },
  };
}

const state = new WeakMap<HTMLElement, { set: (text: string) => void; dispose: () => void }>();

export const vTip: Directive<HTMLElement, string> = {
  mounted(el, binding) {
    const t = attach(el);
    t.set(binding.value);
    state.set(el, t);
  },
  updated(el, binding) {
    state.get(el)?.set(binding.value);
  },
  unmounted(el) {
    state.get(el)?.dispose();
    state.delete(el);
  },
};
