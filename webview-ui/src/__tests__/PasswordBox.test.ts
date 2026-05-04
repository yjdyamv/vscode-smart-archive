import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import PasswordBox from "../components/PasswordBox.vue";

describe("PasswordBox", () => {
  afterEach(() => {
    // Clean up any mock message listeners
  });

  it("renders archive name", () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    expect(wrapper.text()).toContain("test.7z");
  });

  it("shows password input and unlock button", () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
    expect(wrapper.find("button").exists()).toBe(true);
  });

  it("emits submit with password on button click", async () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    const input = wrapper.find("input");
    await input.setValue("secret123");
    await wrapper.find("button.btn").trigger("click");
    expect(wrapper.emitted("submit")?.[0]).toEqual(["secret123"]);
  });

  it("emits submit on Enter key", async () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    const input = wrapper.find("input");
    await input.setValue("mypass");
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("submit")?.[0]).toEqual(["mypass"]);
  });

  it("does not emit submit with empty password", async () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    const input = wrapper.find("input");
    await input.setValue("");
    await wrapper.find("button.btn").trigger("click");
    expect(wrapper.emitted("submit")).toBeUndefined();
  });

  it("shows error state when pwerr message received", async () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });

    // Simulate pwerr message
    window.dispatchEvent(
      new MessageEvent("message", { data: { c: "pwerr", t: "Wrong password" } }),
    );
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("Wrong password");
  });

  it("clears password and shows error on wrong password", async () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    const input = wrapper.find("input");
    await input.setValue("wrongpass");

    window.dispatchEvent(
      new MessageEvent("message", { data: { c: "pwerr", t: "Wrong password" } }),
    );
    await wrapper.vm.$nextTick();

    expect((input.element as HTMLInputElement).value).toBe("");
    expect(wrapper.text()).toContain("Wrong password");
  });

  it("toggles password visibility", async () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    const eyeBtn = wrapper.find('button[class*="absolute"]');
    expect(eyeBtn.exists()).toBe(true);

    await eyeBtn.trigger("mousedown");
    expect(wrapper.find('input[type="text"]').exists()).toBe(true);

    await eyeBtn.trigger("mouseup");
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
  });

  it("has error state hidden by default", () => {
    const wrapper = mount(PasswordBox, { props: { archiveName: "test.7z" } });
    const errDiv = wrapper.find(".min-h-\\[1\\.4em\\]");
    expect(errDiv.attributes("style")).toContain("opacity: 0");
  });
});
