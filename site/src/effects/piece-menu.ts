export interface PieceMenu<Context> {
  attach: (trigger: HTMLButtonElement, context: Context) => void;
  close: () => void;
}

const openMenus = new Set<() => void>();

export function pieceMenu<Context>(menu: HTMLElement, onChoose: (choice: string, context: Context) => void, place?: (trigger: HTMLElement) => void): PieceMenu<Context> {
  let current: { trigger: HTMLButtonElement; context: Context } | undefined;
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>("button[data-choice]")];
  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    current?.trigger.setAttribute("aria-expanded", "false");
    openMenus.delete(close);
  };
  const open = (trigger: HTMLButtonElement, context: Context) => {
    openMenus.forEach((other) => other());
    current = { trigger, context };
    place?.(trigger);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openMenus.add(close);
    items()[0]?.focus();
  };
  menu.addEventListener("click", (event) => {
    const item = (event.target as Element).closest<HTMLButtonElement>("button[data-choice]");
    if (!item || !current) return;
    event.stopPropagation();
    const chosen = current;
    close();
    chosen.trigger.focus();
    onChoose(item.dataset.choice!, chosen.context);
  });
  menu.addEventListener("keydown", (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      const trigger = current?.trigger;
      close();
      trigger?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      all[(at + (event.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    }
  });
  return {
    close,
    attach(trigger, context) {
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-expanded", "false");
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!menu.hidden && current?.trigger === trigger) close();
        else open(trigger, context);
      });
    },
  };
}

document.addEventListener("click", () => openMenus.forEach((close) => close()));
