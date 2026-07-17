// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDocumentTheme, themeBootstrapScript, themeStorageKey } from "@/lib/theme";

function runThemeBootstrap(): void {
  Function(themeBootstrapScript)();
}

describe("首屏主题初始化", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("在首次绘制前应用已保存的浅色主题", () => {
    localStorage.setItem(themeStorageKey, "light");
    runThemeBootstrap();
    expect(readDocumentTheme()).toBe("light");
  });

  it("没有有效配置时使用深色主题", () => {
    localStorage.setItem(themeStorageKey, "unexpected");
    runThemeBootstrap();
    expect(readDocumentTheme()).toBe("dark");
  });

  it("localStorage 不可用时仍能回退到深色主题", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage unavailable"); } });
    try {
      expect(runThemeBootstrap).not.toThrow();
      expect(readDocumentTheme()).toBe("dark");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });
});
