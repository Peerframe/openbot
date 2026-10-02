import type { Bot } from "@openbot/domain";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { RobotAvatar } from "./RobotAvatar";
import { useListScroll } from "./useListScroll";

/**
 * 添加成员 (AddMember artboard): a search field over the Bots not yet in the 频道. Choosing one
 * adds it at once; the popover stays open for the next one and closes on Escape, an outside
 * click, or when nobody is left to add. The Server decides whether the join is allowed.
 */
export function AddMemberPopover({
  candidates,
  busy,
  onAdd,
  onClose,
}: {
  candidates: readonly Bot[];
  busy: boolean;
  onAdd(bot: Bot): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const term = query.trim().toLocaleLowerCase();
  const matches = candidates.filter(
    (bot) => !term || `${bot.name} ${bot.role}`.toLocaleLowerCase().includes(term),
  );
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const listRef = useListScroll(activeIndex);

  useEffect(() => {
    function outside(event: PointerEvent) {
      const target = event.target as Element;
      // The 添加成员 row toggles the popover itself.
      if (root.current?.contains(target) || target.closest?.(".ci-member-add")) return;
      onClose();
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = Math.max(1, matches.length);
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const bot = matches[activeIndex];
      if (bot && !busy) onAdd(bot);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="ci-add-popover" role="dialog" aria-label="添加成员" ref={root}>
      <input
        type="search"
        placeholder="搜索 Bot"
        aria-label="搜索 Bot"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={matches[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        // biome-ignore lint/a11y/noAutofocus: the Owner just opened the picker to search.
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div
        className="ci-add-options"
        role="listbox"
        id={listId}
        aria-label="可添加的 Bot"
        ref={listRef}
      >
        {matches.map((bot, index) => (
          <button
            type="button"
            role="option"
            id={`${listId}-${index}`}
            aria-selected={index === activeIndex}
            tabIndex={-1}
            disabled={busy}
            key={bot.id}
            onMouseEnter={() => setActive(index)}
            onClick={() => onAdd(bot)}
          >
            <RobotAvatar bot={bot} className="ci-add-avatar" />
            {bot.name}
          </button>
        ))}
        {matches.length === 0 ? <p className="ci-add-empty">没有找到这个 Bot</p> : null}
      </div>
    </div>
  );
}
