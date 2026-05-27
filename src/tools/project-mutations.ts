/**
 * MCP mutation tools for BuildTools projects (MOS-218, Phase 5.1).
 *
 * Two tools — each routed through the Phase 4 (MOS-217) two-step confirmation
 * handshake provided by `requiresConfirmation` / `ConfirmationStore`:
 *
 *   - create_project — create a brand-new BuildTools project.
 *   - update_project — patch a subset of fields on an existing project.
 *
 * Design notes (per the planner contract):
 *
 *   - The underlying `BuildToolsAPI.createProject` / `updateProject` methods
 *     were ported in MOS-211/265 and are NOT modified here. We adapt at the
 *     MCP-tool layer instead — that's the entire scope of this issue.
 *
 *   - `requiresConfirmation` produces a `(args, store) => Promise<ToolResult>`
 *     handler, whereas the existing `ToolDefinition.handler` signature is
 *     `(args, api) => Promise<ToolResult>`. We bridge these at registration
 *     time by exporting a FACTORY (`buildProjectMutationTools(store)`) that
 *     closes over the boot-time `ConfirmationStore` and returns concrete
 *     `ToolDefinition[]`. `src/index.ts` calls the factory once. This avoids
 *     touching the read-tool registry's `ToolDefinition.handler` signature.
 *
 *   - For `update_project`, the confirmation prompt must render a diff in
 *     the form `"Change project #<id>'s <field> from <old> → <new>"` (per
 *     acceptance criterion 5). To compute "old" we fetch the existing
 *     project via `api.getProject(project_id)` on the FIRST invocation
 *     (which we'd need anyway because `BuildToolsAPI.updateProject` requires
 *     a `projectManager` value, and we don't accept that on the MCP-tool
 *     surface). The describer's return value is then captured in the
 *     confirmation entry — second-invocation execute uses the original
 *     diff text + the original args.
 *
 *   - The "no-op" branch on `update_project` (no diff fields supplied)
 *     SHORT-CIRCUITS BEFORE `requiresConfirmation` is called. No
 *     confirmation entry is minted, and the API is not invoked.
 *
 *   - Status mapping reuses the best-guess `Active=1 / Complete=6 / Lost=5`
 *     codes that the project read tools already use. `"On Hold"` (mentioned
 *     in the issue prose) has no documented wire code yet and is omitted
 *     pending MOS-222 live verification.
 */

import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { BuildToolsAPI } from "../client/BuildToolsAPI.js";
import { BuildToolsError } from "../client/errors.js";
import {
  ConfirmationStore,
  requiresConfirmation,
} from "../confirm/index.js";

import type { ToolDefinition, ToolResult } from "./projects.js";

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Project-status label → BuildTools wire-code (numeric) for mutations.
 * Mirrors the best-guess map used by the read tools' `STATUS_LABEL_TO_CODES`
 * registry; refining is reserved for MOS-222 live smoke.
 */
const STATUS_LABEL_TO_CODE: Record<"Active" | "Complete" | "Lost", number> = {
  Active: 1,
  Complete: 6,
  Lost: 5,
};

/** Inverse mapping — wire code (string or number) → label, fallback to raw. */
function statusLabel(code: string | number | undefined | null): string {
  if (code === undefined || code === null || code === "") return "—";
  const num = typeof code === "number" ? code : Number(code);
  for (const [label, mappedCode] of Object.entries(STATUS_LABEL_TO_CODE)) {
    if (mappedCode === num) return label;
  }
  return String(code);
}

// ---------------------------------------------------------------------------
// Result + error helpers (local copies — kept independent of projects.ts to
// avoid coupling the mutation surface to a read-tool implementation detail).
// ---------------------------------------------------------------------------

function markdown(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorMarkdown(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function formatError(err: unknown, toolName: string): ToolResult {
  if (err instanceof BuildToolsError) {
    return errorMarkdown(
      `**Error calling \`${toolName}\`** (${err.name}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorMarkdown(`**Error calling \`${toolName}\`**: ${message}`);
}

function formatZodError(err: z.ZodError, toolName: string): ToolResult {
  const issues = err.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- \`${path}\`: ${i.message}`;
    })
    .join("\n");
  return errorMarkdown(
    `**Invalid input for \`${toolName}\`:**\n${issues}`,
  );
}

/** Render a value for inclusion in a diff string. */
function diffValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

/** Stringify upstream API error payloads without leaking a stack trace. */
function formatApiErrors(errors: unknown): string {
  if (errors === undefined || errors === null) return "BuildTools rejected the request (no detail).";
  if (typeof errors === "string") return errors;
  try {
    return JSON.stringify(errors);
  } catch {
    return String(errors);
  }
}

// ---------------------------------------------------------------------------
// Existing-project shape returned by api.getProject()
// ---------------------------------------------------------------------------

/**
 * Minimal projection of the `/projects/:id/form` payload that we need to
 * diff-and-describe an update AND to satisfy `BuildToolsAPI.updateProject`'s
 * required `projectManager` field. Matches `ProjectDetail` in projects.ts.
 */
interface ExistingProject {
  id?: string | number;
  name?: string;
  status?: string | number;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country_code?: string;
  description?: string;
  managers?: Array<string | number> | string;
  employees?: Array<string | number> | string | number;
  [k: string]: unknown;
}

/**
 * Pull a project-manager identifier out of the form-fetch response. The
 * BuildTools form payload uses either `employees` (raw form-field) or
 * `managers` (humanized list). Either may be a single value, an array, or a
 * stringified blob — we accept all and return the first usable identifier.
 *
 * Returns `null` when we cannot resolve a manager — callers surface this as
 * an actionable error rather than blindly POSTing an empty `employees=` field
 * which `BuildToolsAPI.updateProject` would reject with `BuildToolsAuthError`.
 */
function extractProjectManager(
  project: ExistingProject,
): string | number | Array<string | number> | null {
  const fromEmployees = project.employees;
  if (Array.isArray(fromEmployees) && fromEmployees.length > 0) {
    return fromEmployees;
  }
  if (typeof fromEmployees === "string" && fromEmployees.trim() !== "") {
    return fromEmployees;
  }
  if (typeof fromEmployees === "number") {
    return fromEmployees;
  }
  const fromManagers = project.managers;
  if (Array.isArray(fromManagers) && fromManagers.length > 0) {
    return fromManagers;
  }
  if (typeof fromManagers === "string" && fromManagers.trim() !== "") {
    return fromManagers;
  }
  return null;
}

// ===========================================================================
// create_project
// ===========================================================================

const CreateProjectInputSchema = z.object({
  name: z.string().min(1).describe("Project name (visible in BuildTools UI)."),
  customer_id: z
    .number()
    .describe("Existing customer ID (use list_customers to find)."),
  status: z
    .enum(["Active", "Complete", "Lost"])
    .optional()
    .describe(
      "Initial project status. When omitted, BuildToolsAPI's default applies.",
    ),
  address: z.string().optional().describe("Street address."),
  city: z.string().optional(),
  state: z.string().optional().describe("2-letter state code (e.g. 'VA')."),
  zip: z.string().optional(),
  country: z.string().optional().describe("Country code (e.g. 'US')."),
  description: z.string().optional(),
  project_manager: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      "BuildTools employee ID for the project manager. Required by BuildTools server-side; omit only when the tenant accepts unassigned projects.",
    ),
  confirmation_id: z
    .string()
    .optional()
    .describe("Pass on second invocation to execute the mutation."),
});

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

/** Args captured inside the confirmation entry (no confirmation_id). */
type CreateProjectStoredArgs = Omit<CreateProjectInput, "confirmation_id">;

function describeCreateProject(args: CreateProjectStoredArgs): string {
  const lines: string[] = [
    `Create a new BuildTools project named "${args.name}" for customer #${args.customer_id}`,
  ];
  if (args.status) lines.push(`- Status: ${args.status}`);
  const addrParts = [args.address, args.city, args.state, args.zip, args.country]
    .filter((v) => v !== undefined && v !== "");
  if (addrParts.length > 0) lines.push(`- Address: ${addrParts.join(", ")}`);
  if (args.project_manager !== undefined) {
    lines.push(`- Project manager: ${args.project_manager}`);
  }
  if (args.description) lines.push(`- Description: ${args.description}`);
  return lines.join("\n");
}

async function executeCreateProject(
  args: CreateProjectStoredArgs,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  try {
    const result = await api.createProject({
      name: args.name,
      ...(args.status !== undefined && {
        status: STATUS_LABEL_TO_CODE[args.status],
      }),
      ...(args.project_manager !== undefined && {
        projectManager: args.project_manager,
      }),
      ...(args.address !== undefined && { address: args.address }),
      ...(args.city !== undefined && { city: args.city }),
      ...(args.state !== undefined && { state: args.state }),
      ...(args.zip !== undefined && { zip: args.zip }),
      ...(args.country !== undefined && { country: args.country }),
      ...(args.description !== undefined && { description: args.description }),
      clientIds: [args.customer_id],
    });

    if (!result.success) {
      return errorMarkdown(
        `**Error calling \`create_project\`**: BuildTools rejected the create: ${formatApiErrors(result.errors)}`,
      );
    }

    return markdown(
      `✅ Created project #${result.projectId}: ${args.name} (customer #${args.customer_id}).`,
    );
  } catch (err) {
    return formatError(err, "create_project");
  }
}

function buildCreateProjectTool(store: ConfirmationStore): ToolDefinition {
  return {
    name: "create_project",
    description:
      "Create a new BuildTools project. Two-step: first call returns a confirmation prompt with ID; re-invoke with confirmation_id to execute.",
    inputSchema: zodToJsonSchema(CreateProjectInputSchema),
    handler: async (rawArgs, api) => {
      const parsed = CreateProjectInputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) return formatZodError(parsed.error, "create_project");
      const input = parsed.data;

      // Build the confirmation wrapper per-call so the executor captures the
      // live `BuildToolsAPI` reference. The boot-time `store` is shared.
      const wrapped = requiresConfirmation<CreateProjectStoredArgs>(
        "create_project",
        describeCreateProject,
        (storedArgs) => executeCreateProject(storedArgs, api),
      );

      const { confirmation_id, ...rest } = input;
      return wrapped({ ...rest, confirmation_id }, store);
    },
  };
}

// ===========================================================================
// update_project
// ===========================================================================

const UpdateProjectInputSchema = z.object({
  project_id: z.number().describe("BuildTools project ID to update."),
  name: z.string().min(1).optional(),
  status: z.enum(["Active", "Complete", "Lost"]).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional(),
  description: z.string().optional(),
  confirmation_id: z
    .string()
    .optional()
    .describe("Pass on second invocation to execute the mutation."),
});

export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

/**
 * Fields the user can patch via `update_project`. Centralised so the
 * "no diff fields" short-circuit and the diff-renderer agree on what counts
 * as a mutation request.
 */
const UPDATE_DIFF_FIELDS = [
  "name",
  "status",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "description",
] as const;
type UpdateDiffField = (typeof UPDATE_DIFF_FIELDS)[number];

/** Map a stored-args diff field to its existing-project lookup key. */
const EXISTING_FIELD_KEY: Record<UpdateDiffField, keyof ExistingProject> = {
  name: "name",
  status: "status",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  country: "country_code",
  description: "description",
};

interface UpdateStoredArgs {
  project_id: number;
  /** Resolved project-manager identifier — fetched from the existing record. */
  projectManager: string | number | Array<string | number>;
  /** Pre-rendered diff text. The describer returns this verbatim. */
  diffText: string;
  /** Only the fields the user requested to change. */
  changes: Partial<Record<UpdateDiffField, string | undefined>>;
}

function describeUpdateProject(args: UpdateStoredArgs): string {
  return args.diffText;
}

async function executeUpdateProject(
  args: UpdateStoredArgs,
  api: BuildToolsAPI,
): Promise<ToolResult> {
  try {
    const result = await api.updateProject(args.project_id, {
      projectManager: args.projectManager,
      ...(args.changes.name !== undefined && { name: args.changes.name }),
      ...(args.changes.status !== undefined && { status: args.changes.status }),
      ...(args.changes.address !== undefined && { address: args.changes.address }),
      ...(args.changes.city !== undefined && { city: args.changes.city }),
      ...(args.changes.state !== undefined && { state: args.changes.state }),
      ...(args.changes.zip !== undefined && { zip: args.changes.zip }),
      ...(args.changes.country !== undefined && { country: args.changes.country }),
      ...(args.changes.description !== undefined && {
        description: args.changes.description,
      }),
    });

    if (!result.success) {
      return errorMarkdown(
        `**Error calling \`update_project\`**: BuildTools rejected the update: ${formatApiErrors(result.errors)}`,
      );
    }

    return markdown(
      `✅ Updated project #${result.projectId ?? args.project_id}.\n\n${args.diffText}`,
    );
  } catch (err) {
    return formatError(err, "update_project");
  }
}

function buildUpdateProjectTool(store: ConfirmationStore): ToolDefinition {
  return {
    name: "update_project",
    description:
      "Update fields on an existing BuildTools project. Two-step confirmation required.",
    inputSchema: zodToJsonSchema(UpdateProjectInputSchema),
    handler: async (rawArgs, api) => {
      const parsed = UpdateProjectInputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) return formatZodError(parsed.error, "update_project");
      const input = parsed.data;

      // Second-invocation fast path: with a confirmation_id, we don't need to
      // re-fetch the existing project. `requiresConfirmation` will pull the
      // stored args (which already include the captured projectManager + diff
      // text) and call the executor. The no-op short-circuit below does NOT
      // apply on the second call — the captured args are the source of truth.
      if (input.confirmation_id) {
        const wrapped = requiresConfirmation<UpdateStoredArgs>(
          "update_project",
          describeUpdateProject,
          (storedArgs) => executeUpdateProject(storedArgs, api),
        );
        // The args supplied here only need `confirmation_id` — the wrapper
        // discards everything else when it consumes the stored entry. We pass
        // a typed-but-unused payload to satisfy the type signature.
        const placeholder: UpdateStoredArgs = {
          project_id: input.project_id,
          projectManager: "",
          diffText: "",
          changes: {},
        };
        return wrapped(
          { ...placeholder, confirmation_id: input.confirmation_id },
          store,
        );
      }

      // First-invocation no-op short-circuit (acceptance criterion 6): if the
      // user supplied `project_id` only — no diff fields — we MUST NOT mint
      // a confirmation entry and MUST NOT call the BuildTools API.
      const suppliedFields: UpdateDiffField[] = UPDATE_DIFF_FIELDS.filter(
        (f) => input[f] !== undefined,
      );
      if (suppliedFields.length === 0) {
        return markdown(
          `No changes to apply to project #${input.project_id}. Supply at least one field (${UPDATE_DIFF_FIELDS.join(", ")}) to update.`,
        );
      }

      // First invocation: fetch existing project to compute diff and resolve
      // the projectManager.
      let existing: ExistingProject | null;
      try {
        existing = await api.getProject<ExistingProject>(input.project_id);
      } catch (err) {
        return formatError(err, "update_project");
      }
      if (!existing) {
        return errorMarkdown(
          `**Error calling \`update_project\`**: project #${input.project_id} not found.`,
        );
      }

      const projectManager = extractProjectManager(existing);
      if (projectManager === null) {
        return errorMarkdown(
          `**Error calling \`update_project\`**: project #${input.project_id} has no project manager on record. BuildTools requires a project manager to save a project; assign one in the BuildTools UI and retry.`,
        );
      }

      // Build the diff text + the wire-formatted `changes` payload.
      const diffLines: string[] = [];
      const changes: Partial<Record<UpdateDiffField, string | undefined>> = {};

      for (const field of suppliedFields) {
        const newRawValue = input[field];
        let newDisplay: string;
        let newWire: string | undefined;
        let oldDisplay: string;

        if (field === "status") {
          const label = newRawValue as "Active" | "Complete" | "Lost";
          newDisplay = label;
          newWire = String(STATUS_LABEL_TO_CODE[label]);
          oldDisplay = statusLabel(existing.status);
        } else {
          newDisplay = diffValue(newRawValue);
          newWire = newRawValue as string;
          const existingKey = EXISTING_FIELD_KEY[field];
          oldDisplay = diffValue(existing[existingKey]);
        }

        diffLines.push(
          `Change project #${input.project_id}'s ${field} from ${oldDisplay} → ${newDisplay}`,
        );
        changes[field] = newWire;
      }

      const diffText = diffLines.join("\n");

      const wrapped = requiresConfirmation<UpdateStoredArgs>(
        "update_project",
        describeUpdateProject,
        (storedArgs) => executeUpdateProject(storedArgs, api),
      );

      const storedArgs: UpdateStoredArgs = {
        project_id: input.project_id,
        projectManager,
        diffText,
        changes,
      };

      // No confirmation_id on first call — the wrapper will mint + return one.
      return wrapped(storedArgs, store);
    },
  };
}

// ===========================================================================
// Factory
// ===========================================================================

/**
 * Build the two mutation tools, bound to the boot-time `ConfirmationStore`.
 * Called once from `src/index.ts` so the store is shared across calls and
 * its sweep timer covers both tools' pending entries.
 */
export function buildProjectMutationTools(
  store: ConfirmationStore,
): ToolDefinition[] {
  return [buildCreateProjectTool(store), buildUpdateProjectTool(store)];
}
