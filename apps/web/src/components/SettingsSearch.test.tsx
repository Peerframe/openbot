// @vitest-environment jsdom
import { expect, it } from "vitest";
import { interact, renderComponent, setInputValue } from "../test/render-component";
import { SettingsSearch, useSettingsSearch } from "./SettingsSearch";

function List({ names }: { names: string[] }) {
  const search = useSettingsSearch(names.length);
  return (
    <>
      <SettingsSearch search={search} count={names.length} noun="主机" />
      <ul>
        {names.filter(search.matches).map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </>
  );
}

it("shows the search only past 20 entries and filters by it", async () => {
  const short = await renderComponent(
    <List names={Array.from({ length: 20 }, (_, i) => `主机 ${i}`)} />,
  );
  expect(short.container.querySelector("input")).toBeNull();
  await short.unmount();

  const long = await renderComponent(
    <List names={[...Array.from({ length: 20 }, (_, i) => `主机 ${i}`), "Mac mini"]} />,
  );
  const input = long.container.querySelector("input");
  if (!input) throw new Error("No search");
  expect(input.placeholder).toBe("搜索 21 个主机");
  await setInputValue(input, "mac");
  await interact(async () => undefined);
  expect([...long.container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "Mac mini",
  ]);
  await long.unmount();
});
