/**
 * Regression tests for the selections HTML parser.
 *
 * Pinned to a fixture (selections-grid.html) captured live from
 * moss.buildtools.app on 2026-06-12. Covers all four status row shapes
 * (Open=1, Selected=2, Approved=3, Complete=5) because the legacy parser
 * silently leaked Location and status-badge titles into the `item`
 * field — a bug PowerBI / Designer Capacity caught downstream, not us.
 *
 * The Approved row is deliberately included because BuildTools strips the
 * `edit-*` classes from locked rows (no-edit mode); the parser must still
 * read item/location/category positionally off the <td> indices.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { BuildToolsAPI } from "../BuildToolsAPI.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const gridHtml = readFileSync(
  join(__dirname, "fixtures", "selections-grid.html"),
  "utf-8",
);

function makeStub(body: string) {
  const stub: typeof fetch = (async () =>
    new Response(body, { status: 200 })) as typeof fetch;
  return stub;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("BuildToolsAPI.getSelections — item-name regression", () => {
  it("extracts the real item name across every status (no Location/badge bleed)", async () => {
    // /selections?PR[]= returns { grids: <html>, statusCount: {...} }.
    const response = JSON.stringify({
      grids: gridHtml,
      statusCount: { Open: 1, Selected: 1, Approved: 1, Complete: 2 },
    });
    const api = new BuildToolsAPI({ fetch: makeStub(response) } as any);
    (api as unknown as { authenticated: boolean }).authenticated = true;

    const result = await api.getSelections(185928);

    expect(result.selections).toHaveLength(5);

    const byId = Object.fromEntries(
      result.selections.map((s) => [s.id, s]),
    );

    // Editable rows (statuses 1, 2, 5) — `edit-name` class present.
    expect(byId["18345"].item).toBe("Kitchen Cabinets");
    expect(byId["18345"].location).toBe("Kitchen");
    expect(byId["18345"].status).toBe("Complete");
    expect(byId["18345"].selection).toBe("Actual Quote");

    expect(byId["20427"].item).toBe("Cabinet Hardware");
    expect(byId["20427"].location).toBe("Kitchen");
    expect(byId["20427"].dueDate).toBe("05/13/2026");

    // Open row — historical bug: item was "Incomplete" (status-badge title).
    expect(byId["19155"].item).toBe('24" Drawer Microwave Homeowner provided');
    expect(byId["19155"].status).toBe("Open");

    // Selected row — historical bug: item was "Pending" (status-badge title).
    expect(byId["20435"].item).toBe("Tax and Freight");
    expect(byId["20435"].status).toBe("Selected");

    // Approved row — `edit-*` classes stripped; parser must still find
    // the name positionally (cell 6) and the picked option (icon-0012).
    expect(byId["18738"].item).toBe("Sunroom and Kitchen/LR Paint");
    expect(byId["18738"].location).toBe("Typical Room");
    expect(byId["18738"].category).toBe("8330 - Paint Material");
    expect(byId["18738"].status).toBe("Approved");
    expect(byId["18738"].selection).toBe(
      "Benjamin Moore AF690 Metropolitain Eggshell",
    );

    // Negative assertions: item must NEVER be a status-badge title or
    // a location value across the whole sample.
    for (const s of result.selections) {
      expect(["Incomplete", "Pending", "Approved", "Purchased"]).not.toContain(
        s.item,
      );
      expect(s.item).not.toBe(s.location);
    }
  });
});
