/**
 * Unit tests for `src/tools/attachments.ts` (MOS-216, Phase 3.3).
 *
 * These tests exercise the tool handler with a hand-rolled stub for
 * `BuildToolsAPI`. We do NOT instantiate the real class — handlers must not
 * depend on `loadConfigFromEnv()`, must not hit the network, and must not
 * require live credentials.
 *
 * Coverage per the planner contract (criterion 12):
 *   (a) happy-path Markdown shape
 *   (b) empty result
 *   (c) API-error path returns Markdown error content with isError: true
 *   (d) Zod-invalid input returns Markdown error content with isError: true
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildToolsAPI } from "../../client/BuildToolsAPI.js";
import {
  BuildToolsAuthError,
  BuildToolsServerError,
} from "../../client/errors.js";

import {
  attachmentTools,
  downloadAttachmentTool,
  listProjectAttachmentsTool,
} from "../attachments.js";
import { type ToolResult } from "../projects.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeApi(overrides: {
  getProjectAttachments?: BuildToolsAPI["getProjectAttachments"];
  downloadAttachment?: BuildToolsAPI["downloadAttachment"];
}): BuildToolsAPI {
  return overrides as unknown as BuildToolsAPI;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => "text" in c ? c.text : "").join("");
}

const samplePdfAttachment = {
  id: 800001,
  name: "scope-revision-1.pdf",
  module_id: 500001,
  extension: "pdf",
  public_url: "https://example.com/attachments/scope-revision-1.pdf",
  key: "attachments/scope-revision-1.pdf",
  size: 245123,
  created_at: "02/04/2026 09:15:00",
  user_id: 9001,
  user_name: "Project Manager A",
};

const sampleSecondPdf = {
  id: 800002,
  name: "approval-signed.pdf",
  module_id: 500001,
  extension: "pdf",
  public_url: "https://example.com/attachments/approval-signed.pdf",
  key: "attachments/approval-signed.pdf",
  size: 89234,
  created_at: "02/05/2026 14:30:00",
  user_id: 9002,
  user_name: "Project Manager B",
};

const samplePngAttachment = {
  id: 800003,
  name: "bathroom-rendering.png",
  module_id: 500002,
  extension: "png",
  public_url: "https://example.com/attachments/bathroom-rendering.png",
  key: "attachments/bathroom-rendering.png",
  size: 1245678,
  created_at: "11/02/2025 10:00:00",
  user_id: 9003,
  user_name: "Project Manager C",
};

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe("attachmentTools registry", () => {
  it("exports the contract-mandated tools", () => {
    const names = attachmentTools.map((t) => t.name);
    expect(names).toEqual(["list_project_attachments", "download_attachment"]);
  });

  it("the tool exposes a JSON Schema for its input", () => {
    expect(listProjectAttachmentsTool.inputSchema).toBeDefined();
    const schema = listProjectAttachmentsTool.inputSchema as {
      type?: string;
    };
    expect(schema.type).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// list_project_attachments
// ---------------------------------------------------------------------------

describe("list_project_attachments", () => {
  it("renders a Markdown table on the happy path (type_filter: all)", async () => {
    const getProjectAttachments = vi
      .fn()
      .mockResolvedValue([samplePdfAttachment, sampleSecondPdf, samplePngAttachment]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 100002 },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**0 folders** and **3 files** in project #100002");
    expect(text).toContain("| Name | Type | Size | Uploaded | By | Download |");
    expect(text).toContain("scope-revision-1.pdf");
    expect(text).toContain("approval-signed.pdf");
    expect(text).toContain("bathroom-rendering.png");
    expect(text).toContain("pdf (document)");
    expect(text).toContain("png (image)");
    // Size is humanised (245,123 bytes → 239.4 KB).
    expect(text).toMatch(/239\.\d KB/);
    expect(text).toContain(
      "[Download](https://example.com/attachments/scope-revision-1.pdf)",
    );
    expect(getProjectAttachments).toHaveBeenCalledWith(100002, {
      folderId: undefined,
    });
  });

  it("filters to images-only when type_filter='images'", async () => {
    const getProjectAttachments = vi
      .fn()
      .mockResolvedValue([samplePdfAttachment, samplePngAttachment]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 100002, type_filter: "images" },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**0 folders** and **1 file** in project #100002");
    expect(text).toContain("type_filter: images");
    expect(text).toContain("bathroom-rendering.png");
    expect(text).not.toContain("scope-revision-1.pdf");
  });

  it("filters to documents-only when type_filter='documents'", async () => {
    const getProjectAttachments = vi
      .fn()
      .mockResolvedValue([samplePdfAttachment, samplePngAttachment]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 100002, type_filter: "documents" },
      api,
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**0 folders** and **1 file** in project #100002");
    expect(text).toContain("type_filter: documents");
    expect(text).toContain("scope-revision-1.pdf");
    expect(text).not.toContain("bathroom-rendering.png");
  });

  it("returns a Markdown 'no attachments' message when the result is empty (no isError)", async () => {
    const getProjectAttachments = vi.fn().mockResolvedValue([]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 9 },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No attachments found in project #9");
  });

  it("returns 'no attachments' with the type_filter trailer when filtered to empty", async () => {
    const getProjectAttachments = vi
      .fn()
      .mockResolvedValue([samplePdfAttachment]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 100002, type_filter: "images" },
      api,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("No attachments found in project #100002");
    expect(textOf(result)).toContain("type_filter: images");
  });

  it("renders folders and files in separate sections and links folder IDs", async () => {
    const getProjectAttachments = vi.fn().mockResolvedValue([
      {
        id: 134629,
        name: "Drawings",
        is_dir: true,
        created_at: "2025-12-24 16:35:00",
        user_name: "Emmett Zamani",
      },
      samplePdfAttachment,
    ]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 185936 },
      api,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("**1 folder** and **1 file** in project #185936");
    expect(text).toContain("### Folders");
    expect(text).toContain("### Files");
    expect(text).toContain("📁 Drawings");
    expect(text).toContain("| 134629 |");
    expect(text).toContain("folder_id=<Folder ID>");
    expect(text).toContain("scope-revision-1.pdf");
  });

  it("passes folder_id through to the client method on drilldown", async () => {
    const getProjectAttachments = vi.fn().mockResolvedValue([]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    await listProjectAttachmentsTool.handler(
      { project_id: 185936, folder_id: 134629 },
      api,
    );
    expect(getProjectAttachments).toHaveBeenCalledWith(185936, {
      folderId: 134629,
    });
  });

  it("renders missing fields as em-dashes rather than throwing", async () => {
    const getProjectAttachments = vi.fn().mockResolvedValue([
      // Minimal row: no extension, no size, no created_at, no public_url.
      { id: 12345, name: "mystery-file" },
    ]);
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 1 },
      api,
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("mystery-file");
    expect(text).toContain("| — |");
  });

  it("returns Markdown error content (isError: true) on BuildToolsError", async () => {
    const getProjectAttachments = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 1 },
      api,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
    expect(textOf(result)).toContain("BuildToolsAuthError");
  });

  it("returns Markdown error content (isError: true) on a generic server error", async () => {
    const getProjectAttachments = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError("Internal server error", { status: 500 }),
      );
    const api = fakeApi({
      getProjectAttachments:
        getProjectAttachments as BuildToolsAPI["getProjectAttachments"],
    });

    const result = await listProjectAttachmentsTool.handler(
      { project_id: 1 },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("BuildToolsServerError");
  });

  it("returns Markdown error content (isError: true) on Zod-invalid input", async () => {
    // project_id is required and must be a number.
    const result = await listProjectAttachmentsTool.handler({}, fakeApi({}));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "Invalid input for `list_project_attachments`",
    );
    expect(textOf(result)).toContain("project_id");
  });

  it("returns Markdown error content (isError: true) when type_filter is invalid", async () => {
    const result = await listProjectAttachmentsTool.handler(
      { project_id: 1, type_filter: "videos" },
      fakeApi({}),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("type_filter");
  });
});

// ---------------------------------------------------------------------------
// download_attachment
// ---------------------------------------------------------------------------

describe("download_attachment", () => {
  it("returns an embedded resource block with base64 blob, mime, and filename", async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      buffer: Buffer.from("%PDF-1.4 fake pdf bytes"),
      mimeType: "application/pdf",
      filename: "plans.pdf",
      finalUrl: "https://s3.amazonaws.com/bucket/plans.pdf?sig=abc",
    });
    const api = fakeApi({
      downloadAttachment:
        downloadAttachment as BuildToolsAPI["downloadAttachment"],
    });

    const result = await downloadAttachmentTool.handler(
      { url: "https://file.buildtools.app/o/0ye79w/file/hash/abc" },
      api,
    );

    expect(result.isError).toBeFalsy();
    const summary = (result.content[0] as { text?: string }).text ?? "";
    expect(summary).toContain("plans.pdf");
    expect(summary).toContain("application/pdf");

    const resource = result.content[1] as {
      type: string;
      resource: { uri: string; mimeType: string; blob: string };
    };
    expect(resource.type).toBe("resource");
    expect(resource.resource.mimeType).toBe("application/pdf");
    expect(resource.resource.blob).toBe(
      Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64"),
    );
    // The resource URI is a custom scheme so Claude Desktop's MCP
    // validator accepts it; the source download URL never appears in
    // the response body.
    expect(resource.resource.uri).toMatch(/^buildtools:\/\/attachment\//);
    expect(resource.resource.uri).not.toContain("s3.amazonaws.com");
    expect(downloadAttachment).toHaveBeenCalledWith(
      "https://file.buildtools.app/o/0ye79w/file/hash/abc",
    );
  });

  it("returns Markdown error content (isError: true) when the URL is not a URL", async () => {
    const api = fakeApi({});
    const result = await downloadAttachmentTool.handler(
      { url: "not-a-url" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid input for `download_attachment`");
  });

  it("surfaces BuildToolsError thrown by the client (e.g. SSRF reject) as a tool error", async () => {
    const downloadAttachment = vi
      .fn()
      .mockRejectedValue(
        new BuildToolsServerError(
          "Refusing to download from non-allowlisted host: evil.example.com",
        ),
      );
    const api = fakeApi({
      downloadAttachment:
        downloadAttachment as BuildToolsAPI["downloadAttachment"],
    });
    const result = await downloadAttachmentTool.handler(
      { url: "https://evil.example.com/exfil" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("non-allowlisted host");
  });

  it("surfaces auth errors as tool errors", async () => {
    const downloadAttachment = vi
      .fn()
      .mockRejectedValue(new BuildToolsAuthError("Not authenticated"));
    const api = fakeApi({
      downloadAttachment:
        downloadAttachment as BuildToolsAPI["downloadAttachment"],
    });
    const result = await downloadAttachmentTool.handler(
      { url: "https://file.buildtools.app/o/abc" },
      api,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not authenticated");
  });
});
