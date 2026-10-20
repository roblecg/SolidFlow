/** Hit testing for the inspect preview. Shared by the studio and the pop-out. */
function solidFlowArea(bounds) {
  return bounds.width * bounds.height;
}

function solidFlowCoversFrame(bounds, frame) {
  const frameW = frame && frame.width > 0 ? frame.width : 0;
  const frameH = frame && frame.height > 0 ? frame.height : 0;
  if (frameW < 16 || frameH < 16) return false;
  return bounds.width >= frameW * 0.8 && bounds.height >= frameH * 0.8;
}

function solidFlowHitTest(nodes, x, y, frame) {
  const frameArea = Math.max(1, (frame && frame.width) || 1) * Math.max(1, (frame && frame.height) || 1);
  const hits = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const bounds = node && node.bounds;
    if (!bounds || bounds.width < 1 || bounds.height < 1) continue;
    if (x < bounds.x || y < bounds.y || x > bounds.x + bounds.width || y > bounds.y + bounds.height) continue;
    if (!node.control && solidFlowCoversFrame(bounds, frame)) continue;
    hits.push(node);
  }
  hits.sort((a, b) => solidFlowArea(a.bounds) - solidFlowArea(b.bounds));
  const smallest = hits[0];
  if (!smallest) return null;
  if (smallest.control && !solidFlowCoversFrame(smallest.bounds, frame)) return smallest;
  let control = null;
  for (let i = 0; i < hits.length; i++) {
    const node = hits[i];
    if (!node.control || solidFlowCoversFrame(node.bounds, frame)) continue;
    if (solidFlowArea(node.bounds) > frameArea * 0.45) continue;
    if (!control || solidFlowArea(node.bounds) < solidFlowArea(control.bounds)) control = node;
  }
  if (!control) return smallest;
  if (smallest.control) return solidFlowArea(smallest.bounds) <= solidFlowArea(control.bounds) ? smallest : control;
  if (solidFlowArea(control.bounds) > solidFlowArea(smallest.bounds) * 6) return smallest;
  return control;
}

function solidFlowCreateHighlight() {
  const box = document.createElement("div");
  box.className = "highlight";
  box.hidden = true;
  const caption = document.createElement("span");
  caption.className = "highlight-label";
  box.append(caption);
  return box;
}

function solidFlowPlaceHighlight(box, hit, imageSize, imageRect) {
  if (!hit) {
    box.hidden = true;
    return;
  }
  const scaleX = imageRect.width / (imageSize.width || imageRect.width || 1);
  const scaleY = imageRect.height / (imageSize.height || imageRect.height || 1);
  const left = hit.bounds.x * scaleX;
  const top = hit.bounds.y * scaleY;
  box.hidden = false;
  box.style.left = left + "px";
  box.style.top = top + "px";
  box.style.width = Math.max(0, hit.bounds.width * scaleX) + "px";
  box.style.height = Math.max(0, hit.bounds.height * scaleY) + "px";
  box.classList.toggle("label-inside", top < 20);
  const caption = box.querySelector(".highlight-label");
  if (caption) caption.textContent = hit.label || hit.selector || "";
}
