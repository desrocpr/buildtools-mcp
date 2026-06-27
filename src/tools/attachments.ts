/**
 * MCP read-only tools for BuildTools attachments (MOS-216, Phase 3.3).
 *
 * One tool:
 *   - list_project_attachments — files for a project, rendered as a
 *                                Markdown TABLE with download URLs and a
 *                                client-side `type_filter` of
 *                                "images" | "documents" | "all".
 *
 * Design notes:
 *
 *   - Mirrors `src/tools/projects.ts` / `src/tools/financial.ts` conventions:
 *     Zod-validated input, Markdown text response, `isError: true` content
 *     branch on `BuildToolsError`, never throws to the SDK. Empty results
 *     render as plain Markdown (no `isError`).
 *   - Output is a Markdown TABLE per the planner contract (criterion 5),
 *     with columns: name, type, size, upload date, download URL.
 *   - `type_filter` semantics:
 *       images    => extension in {png, jpg, jpeg, gif, webp, svg, bmp}
 *       documents => everything that is NOT an image
 *       all       => no filter (default)
 *     Applied client-side after the API call.
 *   - The client method (`getProjectAttachments(projectId)`) hits
 *     `/documents?PR[]=:id` with NO `list=` filter — module-agnostic — so
 *     this tool surfaces ALL files visible on the project's Documents tab,
 *     not just one module's. Path semantics are inferred and pending live
 *     verification (MOS-222 smoke).
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Markdown response shorthand. */
function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** Error Markdown response shorthand. */
function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Normalise unknown errors into a Markdown body. Distinguishes our own
 * `BuildToolsError` (caller-actionable) from anything else.
 */
function formatError(err: unknown, toolName: string): ToolResult {
  if (err instanceof BuildToolsError) {
    return errorMarkdown(
      `**Error calling \`${toolName}\`** (${err.name}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorMarkdown(`**Error calling \`${toolName}\`**: ${message}`);
}

/** Pretty-print a Zod error as a bulleted list. */
function formatZodError(err: z.ZodError, toolName: string): ToolResult {
  const issues = err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- \`${path}\`: ${i.message}`;
    })
    .join("\n");
  return errorMarkdown(`**Invalid input for \`${toolName}\`:**\n${issues}`);
}

/** Image extensions surfaced via `type_filter: "images"`. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
]);

/**
 * Tells the type-filter helper how to bucket a file. Returns `"image"` when
 * the extension is in `IMAGE_EXTENSIONS`, `"document"` otherwise. Unknown /
 * missing extensions are treated as documents (best-guess; image extensions
 * are a known closed set).
 */
function classifyAttachment(
  row: Record<string, unknown>,
): "image" | "document" {
  const ext =
    typeof row.extension === "string" ? row.extension.toLowerCase() : "";
  const fromExt = ext && IMAGE_EXTENSIONS.has(ext) ? "image" : null;
  if (fromExt) return fromExt;
  // Fall back to the file extension parsed off the name.
  const name = typeof row.name === "string" ? row.name : "";
  const m = name.match(/\.([A-Za-z0-9]+)$/);
  if (m) {
    const nameExt = m[1].toLowerCase();
    if (IMAGE_EXTENSIONS.has(nameExt)) return "image";
  }
  return "document";
}

/**
 * Format a byte count for table display. Uses base-1024 binary prefixes
 * (BuildTools' "size" column is in bytes per the fixture).
 */
function formatSize(value: unknown): string {
  let n: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) n = value;
  else if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Escape `|` so cell text doesn't break the Markdown table layout. Also
 * collapses newlines into spaces.
 */
function escapeCell(value: unknown): string {
  if (value === undefined || value === null) return "—";
  const s = String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  return s === "" ? "—" : s;
}

// ---------------------------------------------------------------------------
// list_project_attachments
// ---------------------------------------------------------------------------

const ListProjectAttachmentsInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID."),
  folder_id: z
    .number()
    .optional()
    .describe(
      "Folder ID to drill into. Omit for the root listing (top-level folders + files). Get folder IDs from a prior call's `📁 #<id>` entries.",
    ),
  type_filter: z
    .enum(["images", "documents", "all"])
    .optional()
    .describe(
      "Filter file types. images = png/jpg/jpeg/gif/webp/svg/bmp; documents = everything else. Folders are always shown. Default: all.",
    ),
});

export type ListProjectAttachmentsInput = z.infer<
  typeof ListProjectAttachmentsInputSchema
>;

function isFolder(row: Record<string, unknown>): boolean {
  return row.is_dir === true || row.is_dir === 1;
}

async function listProjectAttachmentsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListProjectAttachmentsInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "list_project_attachments");
  }
  const { project_id, folder_id } = parsed.data;
  const typeFilter = parsed.data.type_filter ?? "all";

  try {
    const items = await api.getProjectAttachments(project_id, {
      folderId: folder_id,
    });
    // BuildTools' root listing also embeds UI pseudo-entries (System
    // Documents, Recycle Bin) that have no numeric `id`. Drop them so
    // only real folders and files render.
    const realItems = items.filter((r) => typeof r.id === "number");
    const folders = realItems.filter(isFolder);
    let files = realItems.filter((r) => !isFolder(r));

    if (typeFilter === "images") {
      files = files.filter((r) => classifyAttachment(r) === "image");
    } else if (typeFilter === "documents") {
      files = files.filter((r) => classifyAttachment(r) === "document");
    }

    const locationLabel =
      folder_id !== undefined
        ? `folder #${folder_id} of project #${project_id}`
        : `project #${project_id}`;
    const filterTrailer =
      typeFilter === "all" ? "" : ` (type_filter: ${typeFilter})`;

    if (folders.length === 0 && files.length === 0) {
      return markdown(`No attachments found in ${locationLabel}${filterTrailer}.`);
    }

    const sections: string[] = [];
    sections.push(
      `**${folders.length} folder${folders.length === 1 ? "" : "s"}** and **${files.length} file${files.length === 1 ? "" : "s"}** in ${locationLabel}${filterTrailer}:`,
    );

    if (folders.length > 0) {
      sections.push("### Folders");
      sections.push("| Name | Folder ID | Created | Created By |");
      sections.push("|---|---|---|---|");
      for (const row of folders) {
        const name = escapeCell(row.name ?? "(unnamed)");
        const id = escapeCell(row.id);
        const created = escapeCell(row.created_at);
        const user = escapeCell(row.user_name);
        sections.push(`| 📁 ${name} | ${id} | ${created} | ${user} |`);
      }
      sections.push(
        `\n_To list a folder's contents, call list_project_attachments with project_id=${project_id} and folder_id=<Folder ID>._`,
      );
    }

    if (files.length > 0) {
      sections.push("### Files");
      sections.push("| Name | Type | Size | Uploaded | By | Download |");
      sections.push("|---|---|---|---|---|---|");
      for (const row of files) {
        const name = escapeCell(row.name ?? "(unnamed)");
        const ext =
          typeof row.extension === "string" && row.extension !== ""
            ? row.extension
            : typeof row.name === "string"
              ? (row.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "")
              : "";
        const typeLabel = ext
          ? `${ext.toLowerCase()} (${classifyAttachment(row)})`
          : `(${classifyAttachment(row)})`;
        const size = formatSize(row.size);
        const uploaded = escapeCell(row.created_at);
        const user = escapeCell(row.user_name);
        // Prefer `url_main` — the session-scoped owner URL that actually
        // serves the bytes. `public_url` (the /f/.../<hash>.<ext> shape)
        // returns 500 "Core owner is not imported" on this tenant.
        const url =
          (typeof row.url_main === "string" && row.url_main) ||
          (typeof row.public_url === "string" && row.public_url) ||
          "";
        const downloadCell = url ? `[Download](${url})` : "—";
        sections.push(
          `| ${name} | ${escapeCell(typeLabel)} | ${size} | ${uploaded} | ${user} | ${downloadCell} |`,
        );
      }
    }

    return markdown(sections.join("\n"));
  } catch (err) {
    return formatError(err, "list_project_attachments");
  }
}

export const listProjectAttachmentsTool: ToolDefinition = {
  name: "list_project_attachments",
  description:
    "List folders and files on a BuildTools project's Documents tab. Returns a Markdown listing with folders (drillable via folder_id) and files (with name, type, size, upload date, and download URL). Call with no folder_id for the root listing; pass folder_id to drill into a subfolder.",
  inputSchema: zodToJsonSchema(ListProjectAttachmentsInputSchema),
  permission: "read",
  handler: listProjectAttachmentsHandler,
};

// ---------------------------------------------------------------------------
// download_attachment
// ---------------------------------------------------------------------------

const DownloadAttachmentInputSchema = z.object({
  url: z
    .string()
    .url()
    .describe(
      "A BuildTools-hosted attachment URL (typically https://file.buildtools.app/...). Get these from list_project_attachments' Download column. Only *.buildtools.app and the S3 hosts it redirects to are allowed.",
    ),
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Build a custom-scheme URI for the embedded resource. Claude Desktop's
 * MCP validator rejects external `https://` URLs on resource content
 * (PR #47 attempted to fix the shape but kept the external URL; that
 * still failed). Per the user-reproduced error message:
 *
 *   embedded resource: requires
 *     { type: "resource", resource: { text } | { blob } }
 *
 * Switching to a custom scheme keeps the embedded payload identifiable
 * but unfetchable, which is what the validator allows.
 */
/**
 * Stderr-log a structural fingerprint of the download_attachment
 * response — no base64 body, just the shape. Lets us prove on the
 * server side exactly what was sent if the client rejects it.
 */
function logDownloadShape(branch: "image" | "resource", result: ToolResult): void {
  const fingerprint = {
    branch,
    content: result.content.map((c) => {
      if (c.type === "text") {
        return { type: c.type, text_len: (c as { text: string }).text.length };
      }
      if (c.type === "image") {
        const ic = c as { type: "image"; data: string; mimeType: string };
        return {
          type: ic.type,
          mimeType: ic.mimeType,
          data_len: ic.data.length,
        };
      }
      if (c.type === "resource") {
        const rc = c as {
          type: "resource";
          resource: Record<string, unknown>;
        };
        const r = rc.resource;
        return {
          type: rc.type,
          resource: {
            keys: Object.keys(r),
            uri: r.uri,
            mimeType: r.mimeType,
            blob_len:
              typeof r.blob === "string" ? r.blob.length : undefined,
          },
        };
      }
      return { type: (c as { type: string }).type };
    }),
  };
  process.stderr.write(
    `[download_attachment v4] response shape: ${JSON.stringify(fingerprint)}\n`,
  );
}

function makeAttachmentUri(downloadUrl: string, filename: string): string {
  try {
    const u = new URL(downloadUrl);
    const m = u.pathname.match(/\/hash\/([^/?#]+)/);
    if (m) return `buildtools://attachment/${m[1]}`;
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return `buildtools://attachment/${encodeURIComponent(last)}`;
  } catch {
    // fall through to filename fallback
  }
  return `buildtools://attachment/${encodeURIComponent(filename)}`;
}

async function downloadAttachmentHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = DownloadAttachmentInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "download_attachment");
  }
  const { url } = parsed.data;

  try {
    const { buffer, mimeType, filename, finalUrl } = await api.downloadAttachment(url);
    const base64 = buffer.toString("base64");
    const summary = `Downloaded **${filename}** (${mimeType}, ${formatBytes(buffer.byteLength)}).`;

    // Image MIME → `type: "image"` (well-supported across MCP clients).
    if (mimeType.startsWith("image/")) {
      const result = {
        content: [
          { type: "text" as const, text: summary },
          { type: "image" as const, data: base64, mimeType },
        ],
      };
      logDownloadShape("image", result);
      return result;
    }

    // Everything else → embedded resource with a custom-scheme URI.
    // Strict shape per Claude Desktop's validator: only `uri`, `mimeType`,
    // `blob` — no `_meta`, no extra keys.
    const result = {
      content: [
        { type: "text" as const, text: summary },
        {
          type: "resource" as const,
          resource: {
            uri: makeAttachmentUri(finalUrl, filename),
            mimeType,
            blob: base64,
          },
        },
      ],
    };
    logDownloadShape("resource", result);
    return result;
  } catch (err) {
    return formatError(err, "download_attachment");
  }
}

export const downloadAttachmentTool: ToolDefinition = {
  name: "download_attachment",
  description:
    "[v4 2026-06-02] Download a BuildTools-hosted attachment (PDF, image, doc, etc.) using the authenticated session. Returns the file as an embedded resource so it can be read directly by Claude without going through any external proxy. Pass a download URL from list_project_attachments. Max 25 MB.",
  inputSchema: zodToJsonSchema(DownloadAttachmentInputSchema),
  permission: "read",
  handler: downloadAttachmentHandler,
};

// ---------------------------------------------------------------------------
// upload_attachment
// ---------------------------------------------------------------------------

/**
 * Module codes BT uses to scope an upload to an entity. Verified live
 * 2026-06-27 against `file.buildtools.app/files`. The schema accepts a
 * friendly `entity_type` string and resolves to the code internally so
 * callers never have to know the integer.
 */
const ENTITY_TYPE_TO_MODULE: Record<string, number> = {
  project: 1000,
  purchase_order: 1500,
};

const UploadAttachmentInputSchema = z.object({
  entity_type: z
    .enum(["project", "purchase_order"])
    .describe(
      "Where the file will be attached. 'project' puts it on the project's Documents tab; 'purchase_order' attaches it to a specific PO (visible on the PO's Email/attachments tab).",
    ),
  entity_id: z
    .number()
    .describe(
      "The entity's primary key. For entity_type='project' this is the project_id; for 'purchase_order' it's the PO id.",
    ),
  project_id: z
    .number()
    .optional()
    .describe(
      "The parent project's id. REQUIRED for entity_type='purchase_order' (BT scopes every upload under a project, even when the file's module is something else). Optional for entity_type='project' (defaults to entity_id).",
    ),
  filename: z
    .string()
    .min(1)
    .describe(
      "Original filename including the extension (e.g. 'ADMO55739-F.pdf'). The extension drives BT's UI rendering (preview vs. download).",
    ),
  content_type: z
    .string()
    .optional()
    .describe(
      "MIME type (e.g. 'application/pdf'). Default 'application/octet-stream'. Pass the correct type so BT renders the file properly in its UI.",
    ),
  file_base64: z
    .string()
    .min(1)
    .describe(
      "Base64-encoded file bytes. Max 25 MB decoded. For text files use the same encoding (just base64 the raw bytes). NOT a data: URL prefix — just the base64 payload.",
    ),
});

type UploadAttachmentInput = z.infer<typeof UploadAttachmentInputSchema>;

async function uploadAttachmentHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = UploadAttachmentInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => {
        const path = i.path.length > 0 ? i.path.join(".") : "(root)";
        return `- \`${path}\`: ${i.message}`;
      })
      .join("\n");
    return errorMarkdown(
      `**Invalid input for \`upload_attachment\`:**\n${issues}`,
    );
  }
  const input: UploadAttachmentInput = parsed.data;

  const moduleCode = ENTITY_TYPE_TO_MODULE[input.entity_type];
  if (moduleCode === undefined) {
    // Defensive — Zod's enum should make this unreachable.
    return errorMarkdown(
      `**Invalid entity_type**: "${input.entity_type}". Expected one of: ${Object.keys(ENTITY_TYPE_TO_MODULE).join(", ")}.`,
    );
  }

  // Decode base64. Use Buffer.from with strict=true semantics; trim
  // surrounding whitespace and reject data: URL prefixes so callers
  // who pass them get a clear error rather than upload garbage.
  const b64 = input.file_base64.trim();
  if (b64.startsWith("data:")) {
    return errorMarkdown(
      "**Invalid `file_base64`**: looks like a `data:` URL. Strip the `data:<mime>;base64,` prefix — pass ONLY the base64 payload.",
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return errorMarkdown("**Invalid `file_base64`**: could not decode as base64.");
  }
  if (buf.length === 0) {
    return errorMarkdown(
      "**Invalid `file_base64`**: decoded to zero bytes. Did the base64 string include only whitespace or an empty payload?",
    );
  }

  // Resolve project_id. For project uploads it can default to entity_id.
  // For PO uploads it's required (BT scopes uploads under a project).
  let projectId = input.project_id;
  if (projectId === undefined) {
    if (input.entity_type === "project") {
      projectId = input.entity_id;
    } else {
      return errorMarkdown(
        `**Missing \`project_id\`**: required when entity_type='${input.entity_type}'. Use \`get_purchase_order\` to look up the parent project id.`,
      );
    }
  }

  try {
    const file = await api.uploadAttachment({
      projectId,
      module: moduleCode,
      moduleId: input.entity_id,
      fileBuffer: buf,
      filename: input.filename,
      contentType: input.content_type,
    });
    const sizeKb = (file.size / 1024).toFixed(1);
    const entityLabel =
      input.entity_type === "purchase_order"
        ? `purchase order #${input.entity_id}`
        : `project #${projectId}`;
    // `file.name` is BT's `display_name` which already includes the
    // extension (e.g. "ADMO55739-F.pdf"). The separate `extension`
    // field is for filter logic, not display — appending it here would
    // double-print as "ADMO55739-F.pdf.pdf".
    return markdown(
      `**Attachment uploaded** to ${entityLabel}.\n\n` +
        `- **File**: ${file.name}\n` +
        `- **File ID**: ${file.fileId}\n` +
        `- **Size**: ${sizeKb} KB\n` +
        `- **Type**: ${file.mimeType || input.content_type || "—"}\n` +
        `- **Download**: ${file.downloadUrl}\n` +
        `- **Uploaded**: ${file.createdAt}\n\n` +
        `_The file is now visible via \`list_project_attachments(${projectId})\`._`,
    );
  } catch (err) {
    return formatError(err, "upload_attachment");
  }
}

export const uploadAttachmentTool: ToolDefinition = {
  name: "upload_attachment",
  description:
    "[v1 2026-06-27] Upload a file to BuildTools and associate it with a project or purchase order. " +
    "Pass the file as `file_base64` (base64-encoded bytes, max 25 MB decoded) along with `filename`, `content_type`, " +
    "`entity_type` ('project' or 'purchase_order'), and `entity_id`. For PO uploads also pass `project_id` (the PO's parent project). " +
    "Returns the assigned file_id + download URL. The uploaded file becomes visible via `list_project_attachments`.",
  inputSchema: zodToJsonSchema(UploadAttachmentInputSchema),
  // Reuse `write:operations` — already provisioned for the editor role
  // and semantically closest (project documents and PO attachments are
  // operational artifacts). Adding a fine-grained `write:attachments`
  // permission would require a schema migration + role rotation; defer
  // until usage patterns justify it.
  permission: "write:operations",
  handler: uploadAttachmentHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const attachmentTools: ToolDefinition[] = [
  listProjectAttachmentsTool,
  downloadAttachmentTool,
  uploadAttachmentTool,
];
