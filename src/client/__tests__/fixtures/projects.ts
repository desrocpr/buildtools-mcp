/**
 * Project fixtures for BuildToolsAPI tests.
 *
 * Each fixture is `ProjectSchema.parse(...)` at module load so that the
 * fixtures cannot drift from the schema. A schema change that breaks a
 * fixture surfaces immediately when the test module is imported.
 */

import { ProjectSchema, type Project } from "../../types.js";

export const projectAlpha: Project = ProjectSchema.parse({
  id: 101,
  name: "Smith Renovation",
  status: "6",
  address: "123 Main Street",
  city: "Fairfax",
  state: "VA",
  zip: "22030",
  country_code: "US",
});

export const projectBeta: Project = ProjectSchema.parse({
  id: 102,
  name: "Jones Addition",
  status: 6,
  description: "Two-story addition over garage.",
});

/** DataTables envelope returned by GET /projects/datatable. */
export const projectsDatatablePayload = {
  draw: 1,
  recordsTotal: 2,
  recordsFiltered: 2,
  data: [projectAlpha, projectBeta],
};

/** Successful response shape from POST /projects/save. */
export const createProjectSuccessPayload = {
  r: 1,
  projectId: 999,
};

/** Failure response shape from POST /projects/save. */
export const createProjectFailurePayload = {
  r: 0,
  e: { name: ["Name is required"] },
};

/** Successful response shape from POST /change-orders/save. */
export const createChangeOrderSuccessPayload = {
  result: "success",
  id: 444,
  message: "Change order created",
};
