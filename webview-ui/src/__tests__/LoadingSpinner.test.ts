import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import LoadingSpinner from "../components/LoadingSpinner.vue";

describe("LoadingSpinner", () => {
  it("renders message", () => {
    const wrapper = mount(LoadingSpinner, { props: { msg: "Loading test..." } });
    expect(wrapper.text()).toContain("Loading test...");
  });

  it("has spinner element", () => {
    const wrapper = mount(LoadingSpinner, { props: { msg: "Working" } });
    expect(wrapper.find(".spinner").exists()).toBe(true);
  });
});
