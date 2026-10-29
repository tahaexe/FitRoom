/**
 * `?add=<catalog id>` entry: parse, address cleanup, and card highlight.
 *
 * Pure helpers plus one DOM-only highlight. Nothing here touches the room,
 * its saved copy, or any demo key: the link places nothing until the
 * visitor acts.
 */

/** True when the address carries `?add=` (known or not). */
export function hasStoreAdd(search: string): boolean {
  try {
    return new URLSearchParams(search).has("add");
  } catch {
    return false;
  }
}

/** Read once: the catalog id in `?add=`, or null when missing or unknown. */
export function storeAddIdFromSearch(search: string, has: (id: string) => boolean): string | null {
  let id: string | null;
  try {
    id = new URLSearchParams(search).get("add");
  } catch {
    return null;
  }
  if (id === null || id === "") return null;
  return has(id) ? id : null;
}

/** The same address without `add`, once read ("" when nothing remains). */
export function stripStoreAdd(search: string): string {
  try {
    const params = new URLSearchParams(search);
    params.delete("add");
    const rest = params.toString();
    return rest === "" ? "" : `?${rest}`;
  } catch {
    return search;
  }
}

/** Ring marker on the highlighted catalog card. */
export const STORE_ADD_RING = "store-add-ring";
/** Flag on the highlighted card; the hint carries `data-store-add-hint`. */
export const STORE_ADD_FLAG = "data-store-add";
export const STORE_ADD_HINT = "data-store-add-hint";

/**
 * Ring the card, scroll it into view (sheet top on phones) and add the one
 * entry hint. A later click on the card clears the ring and the hint.
 * DOM-only: the room state is never read or written here.
 */
export function highlightStoreAddCard(
  host: Element,
  card: Element,
  hintText: string,
  phone: boolean,
): Element | null {
  card.setAttribute(STORE_ADD_FLAG, "true");
  card.classList.add(STORE_ADD_RING);
  const styled = card as HTMLElement;
  try {
    styled.style.outline = "3px solid #f54e49";
    styled.style.outlineOffset = "2px";
  } catch {
    // A bare element stub keeps the class and flag without the ring.
  }
  try {
    card.scrollIntoView({ block: phone ? "start" : "nearest" });
  } catch {
    // A card already in view needs no scroll.
  }
  const existing = host.querySelector(`[${STORE_ADD_HINT}]`);
  if (existing !== null) return existing;
  const hint = document.createElement("p");
  hint.setAttribute(STORE_ADD_HINT, "true");
  hint.setAttribute("role", "status");
  hint.textContent = hintText;
  host.prepend(hint);
  card.addEventListener(
    "click",
    () => {
      card.removeAttribute(STORE_ADD_FLAG);
      card.classList.remove(STORE_ADD_RING);
      try {
        styled.style.outline = "";
        styled.style.outlineOffset = "";
      } catch {
        // Nothing to clear on a stub.
      }
      host.querySelector(`[${STORE_ADD_HINT}]`)?.remove();
    },
    { once: true },
  );
  return hint;
}
