// Measures the caret's x position in the composer textarea so the @ and / lists open at the caret.
const mirrored = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "tabSize",
  "textIndent",
  "textTransform",
  "wordSpacing",
] as const;

/**
 * Where character `index` sits inside a textarea, in px from its left edge, using a hidden mirror
 * with the same text metrics. Popovers anchor to this so @ and / lists open at the caret.
 */
export function textareaCaretLeft(textarea: HTMLTextAreaElement, index: number): number {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of mirrored) mirror.style[property] = style[property];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(marker);
  document.body.append(mirror);
  const left = marker.offsetLeft - textarea.scrollLeft;
  mirror.remove();
  return Number.isFinite(left) ? left : 0;
}
