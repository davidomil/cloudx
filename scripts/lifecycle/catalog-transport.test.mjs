import { expect, it, vi } from "vitest";
import { pinnedCatalogFetch } from "./catalog-transport.mjs";

const source = "a".repeat(40),
  target = "b".repeat(40);
const url = "https://api.github.com/repos/davidomil/cloudx";

it("pins the external main catalog and comparison to the selected run", async () => {
  const network = vi.fn();
  const fetch = pinnedCatalogFetch({ source, target }, network);
  expect(await (await fetch(`${url}/commits/main`)).json()).toEqual({
    sha: target,
  });
  expect(
    await (
      await fetch(`${url}/compare/${source}...${target}?per_page=100&page=1`)
    ).json(),
  ).toMatchObject({ status: "ahead", commits: [{ sha: target }] });
  expect(await (await fetch(`${url}/pulls?state=closed`)).json()).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});

it("leaves application and model provider requests on the real network", async () => {
  const response = new Response("real");
  const network = vi.fn().mockResolvedValue(response);
  const fetch = pinnedCatalogFetch({ source, target }, network);
  expect(await fetch("https://127.0.0.1:3001/api/runtime")).toBe(response);
  expect(
    await fetch(new URL("http://127.0.0.1:4000/v1/responses"), {
      method: "POST",
    }),
  ).toBe(response);
  expect(network).toHaveBeenCalledTimes(2);
});

it("rejects unpinned external catalog requests instead of consulting moving remote refs", async () => {
  const network = vi.fn();
  const fetch = pinnedCatalogFetch({ source, target }, network);
  await expect(fetch(`${url}/releases/latest`)).rejects.toThrow(
    "Unexpected GitHub catalog",
  );
  await expect(
    fetch(`${url}/commits/main`, { method: "POST" }),
  ).rejects.toThrow("only serves reads");
  expect(network).not.toHaveBeenCalled();
  expect(() => pinnedCatalogFetch({ source: "main", target })).toThrow();
});
