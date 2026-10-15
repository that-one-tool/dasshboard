import { describe, it, expect } from "vitest";
import type { SftpEntry } from "../../ipc";
import { DEFAULT_SORT, nextSort, viewEntries, type SortState } from "./entryView";

function entry(name: string, kind: SftpEntry["kind"], size = 0, modified?: number): SftpEntry {
  return { name, kind, size, modified } as SftpEntry;
}

const names = (entries: SftpEntry[]) => entries.map((e) => e.name);

describe("nextSort", () => {
  it("flips the direction of the active column", () => {
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("selects a new column ascending", () => {
    expect(nextSort({ key: "name", dir: "desc" }, "size")).toEqual({ key: "size", dir: "asc" });
  });
});

describe("viewEntries", () => {
  const listing = [
    entry("b.txt", "file", 30, 1),
    entry("Zeta", "dir", 0, 5),
    entry("a.txt", "file", 10, 3),
    entry("alpha", "dir", 0, 2),
  ];

  it("sorts folders first, then by name case-insensitively", () => {
    expect(names(viewEntries(listing, "", DEFAULT_SORT))).toEqual(["alpha", "Zeta", "a.txt", "b.txt"]);
  });

  it("keeps folders first when descending", () => {
    const sort: SortState = { key: "name", dir: "desc" };
    expect(names(viewEntries(listing, "", sort))).toEqual(["Zeta", "alpha", "b.txt", "a.txt"]);
  });

  it("sorts by size and by modification time", () => {
    expect(names(viewEntries(listing, "", { key: "size", dir: "desc" }))).toEqual([
      "Zeta",
      "alpha",
      "b.txt",
      "a.txt",
    ]);
    expect(names(viewEntries(listing, "", { key: "modified", dir: "asc" }))).toEqual([
      "alpha",
      "Zeta",
      "b.txt",
      "a.txt",
    ]);
  });

  it("breaks a size tie by name", () => {
    const tied = [entry("b", "file", 5), entry("a", "file", 5)];
    expect(names(viewEntries(tied, "", { key: "size", dir: "asc" }))).toEqual(["a", "b"]);
  });

  it("treats a missing modification time as the oldest", () => {
    const mixed = [entry("new", "file", 0, 9), entry("unknown", "file", 0)];
    expect(names(viewEntries(mixed, "", { key: "modified", dir: "asc" }))).toEqual(["unknown", "new"]);
  });

  it("filters by a trimmed, case-insensitive name match", () => {
    expect(names(viewEntries(listing, "  TXT ", DEFAULT_SORT))).toEqual(["a.txt", "b.txt"]);
  });

  it("never reorders the listing it was given", () => {
    const copy = listing.slice();
    viewEntries(listing, "", DEFAULT_SORT);
    expect(listing).toEqual(copy);
  });
});
