import catalogJson from "../../shared/catalog/catalog.json";
import type { CatalogItem } from "@fitroom/shared";
import { DEMO_STORE_LINE, STORE_OPEN_APP, STORE_SEE_IT, STORE_UNKNOWN } from "./copy";
import { storeModelFor } from "./store-model";

const CATALOG = catalogJson as unknown as CatalogItem[];

function node(id: string): HTMLElement | null {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found : null;
}

const params = new URLSearchParams(window.location.search);
const model = storeModelFor(CATALOG, params.get("id"));

const demoLine = node("store-demo-line");
if (demoLine !== null) demoLine.textContent = DEMO_STORE_LINE;

if (model.status === "ok") {
  document.title = `${model.name} · FitRoom demo store`;
  const thumb = node("store-thumb");
  if (thumb instanceof HTMLImageElement) {
    thumb.src = model.thumbnail;
    thumb.alt = model.name;
  }
  const name = node("store-name");
  if (name !== null) name.textContent = model.name;
  const size = node("store-size");
  if (size !== null) size.textContent = model.sizeText;
  const price = node("store-price");
  if (price !== null) price.textContent = model.priceText;
  const credit = node("store-credit");
  if (credit !== null) credit.textContent = model.credit;
  const seeIt = node("store-see-it");
  if (seeIt instanceof HTMLAnchorElement) {
    seeIt.textContent = STORE_SEE_IT;
    seeIt.href = model.addHref;
  }
  node("store-product")?.removeAttribute("hidden");
} else {
  document.title = "Demo store · FitRoom";
  const missing = node("store-missing-text");
  if (missing !== null) missing.textContent = STORE_UNKNOWN;
  const openApp = node("store-open-app");
  if (openApp instanceof HTMLAnchorElement) {
    openApp.textContent = STORE_OPEN_APP;
    openApp.href = "/";
  }
  node("store-missing")?.removeAttribute("hidden");
}
