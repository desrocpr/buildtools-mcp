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
        const url =
          (typeof row.public_url === "string" && row.public_url) ||
          (typeof row.url_main === "string" && row.url_main) ||
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
  handler: listProjectAttachmentsHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const attachmentTools: ToolDefinition[] = [listProjectAttachmentsTool];
