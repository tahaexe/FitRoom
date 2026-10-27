/**
 * Room menu: the header pill with the current room's name. Items are data,
 * so a later step adds "From photos" without touching the menu itself.
 */

export interface RoomMenuItem {
  id: string;
  label: string;
  hint?: string;
}

export class RoomMenu {
  private readonly button: HTMLButtonElement;
  private readonly list: HTMLElement;
  private items: RoomMenuItem[] = [];
  private currentId = "";

  constructor(
    host: HTMLElement,
    private readonly onPick: (id: string) => void,
  ) {
    host.className = "room-menu";
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "room-menu-pill";
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", () => this.toggle());
    host.appendChild(this.button);
    this.list = document.createElement("div");
    this.list.className = "room-menu-list";
    this.list.setAttribute("role", "menu");
    this.list.setAttribute("hidden", "");
    host.appendChild(this.list);
    document.addEventListener("click", (event) => {
      if (!host.contains(event.target as Node)) this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  setItems(items: RoomMenuItem[], currentId: string): void {
    this.items = items;
    this.currentId = currentId;
    const current = items.find((item) => item.id === currentId);
    this.button.textContent = current?.label ?? "Room";
    this.button.title = "Switch rooms";
    this.list.innerHTML = "";
    for (const item of items) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "room-menu-item";
      option.setAttribute("role", "menuitem");
      option.dataset["active"] = String(item.id === currentId);
      option.textContent = item.label + (item.id === currentId ? " ✓" : "");
      if (item.hint !== undefined) option.title = item.hint;
      option.addEventListener("click", () => {
        this.close();
        this.onPick(item.id);
      });
      this.list.appendChild(option);
    }
  }
  private toggle(): void {
    if (this.list.hasAttribute("hidden")) this.open();
    else this.close();
  }

  private open(): void {
    this.list.removeAttribute("hidden");
    this.button.setAttribute("aria-expanded", "true");
  }

  private close(): void {
    this.list.setAttribute("hidden", "");
    this.button.setAttribute("aria-expanded", "false");
  }
}
