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
  type_filter: z
    .enum(["images", "documents", "all"])
    .optional()
    .describe(
      "Filter attachments by type. images = png/jpg/jpeg/gif/webp/svg/bmp; documents = everything else. Default: all.",
    ),
});

export type ListProjectAttachmentsInput = z.infer<
  typeof ListProjectAttachmentsInputSchema
>;

async function listProjectAttachmentsHandler(
  args: unknown,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  const parsed = ListProjectAttachmentsInputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return formatZodError(parsed.error, "list_project_attachments");
  }
  const { project_id } = parsed.data;
  const typeFilter = parsed.data.type_filter ?? "all";

  try {
    const items = await api.getProjectAttachments(project_id);
    let rows: Array<Record<string, unknown>> = items;

    if (typeFilter === "images") {
      rows = rows.filter((r) => classifyAttachment(r) === "image");
    } else if (typeFilter === "documents") {
      rows = rows.filter((r) => classifyAttachment(r) === "document");
    }

    if (rows.length === 0) {
      const trailer =
        typeFilter === "all" ? "" : ` (type_filter: ${typeFilter})`;
      return markdown(
        `No attachments found for project #${project_id}${trailer}.`,
      );
    }

    const header = `**${rows.length} attachment${rows.length === 1 ? "" : "s"}** for project #${project_id}${typeFilter === "all" ? "" : ` (type_filter: ${typeFilter})`}:`;
    const tableHeader = [
      "| Name | Type | Size | Uploaded | Download |",
      "|---|---|---|---|---|",
    ].join("\n");
    const tableBody = rows
      .map((row) => {
        const name = escapeCell(row.name ?? "(unnamed)");
        const ext =
          typeof row.extension === "string" && row.extension !== ""
            ? row.extension
            : (typeof row.name === "string"
                ? row.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? ""
                : "");
        const typeLabel = ext
          ? `${ext.toLowerCase()} (${classifyAttachment(row)})`
          : `(${classifyAttachment(row)})`;
        const size = formatSize(row.size);
        const uploaded = escapeCell(row.created_at);
        const url = typeof row.public_url === "string" ? row.public_url : "";
        const downloadCell = url
          ? `[Download](${url})`
          : "—";
        return `| ${name} | ${escapeCell(typeLabel)} | ${size} | ${uploaded} | ${downloadCell} |`;
      })
      .join("\n");

    return markdown(`${header}\n\n${tableHeader}\n${tableBody}`);
  } catch (err) {
    return formatError(err, "list_project_attachments");
  }
}

export const listProjectAttachmentsTool: ToolDefinition = {
  name: "list_project_attachments",
  description:
    "List files/attachments associated with a BuildTools project. Returns name, type, size, upload date, and a clickable download URL.",
  inputSchema: zodToJsonSchema(ListProjectAttachmentsInputSchema),
  handler: listProjectAttachmentsHandler,
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const attachmentTools: ToolDefinition[] = [listProjectAttachmentsTool];
