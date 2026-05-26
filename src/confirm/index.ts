/**
 * Barrel for the confirmation framework (MOS-217, Phase 4).
 *
 * Phase 5 mutation tools will import from `src/confirm/index.js`:
 *
 *   import { ConfirmationStore, requiresConfirmation } from "../confirm/index.js";
 */

export {
  ConfirmationStore,
  requiresConfirmation,
  type PendingMutation,
  type ToolResult,
} from "./Confirmation.js";
