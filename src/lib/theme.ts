export type Theme = "dark" | "light";

export const themeStorageKey = "oceanking-theme";

export const themeBootstrapScript = `(() => {
  try {
    const saved = localStorage.getItem("${themeStorageKey}");
    document.documentElement.dataset.theme = saved === "light" ? "light" : "dark";
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();`;

export function readDocumentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
