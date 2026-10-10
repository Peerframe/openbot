// Search box for long settings lists, shown once a list passes 20 entries (LongLists rule).
import { useState } from "react";

/** LongLists: a settings list gets a search box once it holds more than 20 entries. */
export const SETTINGS_SEARCH_AFTER = 20;

/**
 * The search for one settings list. It only filters while the box is shown, so a list that
 * shrinks back to 20 entries never hides rows behind a query the Owner can no longer see.
 */
export function useSettingsSearch(count: number) {
  const [query, setQuery] = useState("");
  const active = count > SETTINGS_SEARCH_AFTER;
  const needle = active ? query.trim().toLocaleLowerCase() : "";
  return {
    active,
    query,
    setQuery,
    matches: (text: string) => !needle || text.toLocaleLowerCase().includes(needle),
  };
}

export function SettingsSearch({
  search,
  count,
  noun,
}: {
  search: ReturnType<typeof useSettingsSearch>;
  count: number;
  noun: string;
}) {
  if (!search.active) return null;
  return (
    <input
      type="search"
      className="settings-search"
      placeholder={`搜索 ${count} 个${noun}`}
      aria-label={`搜索${noun}`}
      value={search.query}
      onChange={(event) => search.setQuery(event.target.value)}
    />
  );
}
