/**
 * v-tip directive — VS Code-style tooltip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, withDirectives } from "vue";
import { vTip } from "../directives/tooltip";

const Host = defineComponent({
  props: { msg: { type: String, default: "tip text" } },
  setup(props) {
    return () =>
      withDirectives(h("div", { class: "anchor", style: "width:100px;height:20px" }, props.msg), [
        [vTip, props.msg],
      ]);
  },
});

function mountHost(msg = "tip text") {
  return mount(Host, {
    props: { msg },
    global: { directives: { tip: vTip } },
    attachTo: document.body,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("v-tip", () => {
  it("shows a themed tooltip after a delay on hover", async () => {
    const w = mountHost("hello tooltip");
    await w.trigger("mouseenter", { clientX: 50, clientY: 60 });
    expect(document.querySelector(".sa-tip")).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    const tip = document.querySelector(".sa-tip");
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toBe("hello tooltip");
    expect(tip?.classList.contains("show")).toBe(true);
  });

  it("hides on mouseleave", async () => {
    const w = mountHost();
    await w.trigger("mouseenter", { clientX: 50, clientY: 60 });
    await vi.advanceTimersByTimeAsync(200);
    await w.trigger("mouseleave");
    expect(document.querySelector(".sa-tip")?.classList.contains("show")).toBe(false);
  });

  it("updates the tooltip text when the bound value changes", async () => {
    const w = mountHost("first");
    await w.trigger("mouseenter", { clientX: 50, clientY: 60 });
    await vi.advanceTimersByTimeAsync(200);
    await w.setProps({ msg: "second" });
    expect(document.querySelector(".sa-tip")?.textContent).toBe("second");
  });

  it("hides the tooltip when the element is unmounted", async () => {
    const w = mountHost();
    await w.trigger("mouseenter", { clientX: 50, clientY: 60 });
    await vi.advanceTimersByTimeAsync(200);
    w.unmount();
    expect(document.querySelector(".sa-tip")?.classList.contains("show")).toBe(false);
  });
});
