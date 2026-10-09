/** Force UI locale via localStorage keys used by KCIM export tool preferences. */
export function localeInitScript(locale: string): string {
  const safe = locale.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `
    (() => {
      try {
        localStorage.setItem('kcim.language', '${safe}');
      } catch (_) {}
    })();
  `;
}
