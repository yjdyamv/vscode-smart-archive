import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Toast from "../components/Toast.vue";

describe("Toast", () => {
  it("renders when visible", () => {
    const wrapper = mount(Toast, {
      props: { msg: "Test message", ok: true, visible: true },
    });
    expect(wrapper.text()).toContain("Test message");
  });

  it("does not render when hidden", () => {
    const wrapper = mount(Toast, {
      props: { msg: "Test message", ok: true, visible: false },
    });
    expect(wrapper.find(".fixed").exists()).toBe(false);
  });

  it("uses green background for success", () => {
    const wrapper = mount(Toast, {
      props: { msg: "OK", ok: true, visible: true },
    });
    const div = wrapper.find(".fixed");
    expect(div.classes().join(" ")).toContain("bg-[var(--vscode-terminal-ansiGreen)]");
  });

  it("uses red background for error", () => {
    const wrapper = mount(Toast, {
      props: { msg: "Error", ok: false, visible: true },
    });
    const div = wrapper.find(".fixed");
    expect(div.classes().join(" ")).toContain("bg-[var(--vscode-inputValidation-errorBackground)]");
  });
});
