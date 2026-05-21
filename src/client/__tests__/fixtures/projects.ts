/**
 * Synthetic fixture data for BuildToolsAPI unit tests.
 *
 * TODO(MOS-211): replace with real sample data from api-data-sample.json
 * once the reference source (~/code/buildtools/) is available.
 */

import type { Project, ChangeOrder, FinancialStatement, Customer, Attachment } from "../../types.js";

export const fixtureProject1: Project = {
  id: 101,
  name: "Moss HQ Renovation",
  status: "active",
  description: "Full interior renovation of the Moss HQ building",
  customer_id: 201,
  address: "123 Moss Ave, Vancouver, BC",
  start_date: "2024-01-15",
  end_date: "2024-12-31",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-06-01T00:00:00Z",
};

export const fixtureProject2: Project = {
  id: 102,
  name: "Oakwood Kitchen Remodel",
  status: "completed",
  description: "Full kitchen renovation",
  customer_id: 202,
  address: "456 Oak St, North Vancouver, BC",
  start_date: "2023-03-01",
  end_date: "2023-09-30",
  created_at: "2023-02-15T00:00:00Z",
  updated_at: "2023-10-05T00:00:00Z",
};

export const fixtureProjects: Project[] = [fixtureProject1, fixtureProject2];

export const fixtureChangeOrder1: ChangeOrder = {
  id: 301,
  project_id: 101,
  title: "Add deck extension",
  status: "approved",
  amount: 15000,
  description: "Extend rear deck by 200 sqft",
  billed: false,
  created_at: "2024-03-01T00:00:00Z",
  updated_at: "2024-03-10T00:00:00Z",
};

export const fixtureChangeOrder2: ChangeOrder = {
  id: 302,
  project_id: 101,
  title: "Upgrade electrical panel",
  status: "pending",
  amount: 8500,
  description: "Replace 100A panel with 200A",
  billed: false,
  created_at: "2024-04-01T00:00:00Z",
  updated_at: "2024-04-02T00:00:00Z",
};

export const fixtureChangeOrders: ChangeOrder[] = [
  fixtureChangeOrder1,
  fixtureChangeOrder2,
];

export const fixtureFinancialStatement: FinancialStatement = {
  project_id: 101,
  contract_value: 250000,
  billed_to_date: 125000,
  payments_received: 100000,
  outstanding_balance: 25000,
  change_orders_total: 23500,
  revised_contract_value: 273500,
  generated_at: "2024-06-01T00:00:00Z",
};

export const fixtureCustomer1: Customer = {
  id: 201,
  name: "Moss Building & Design",
  email: "info@mossbd.com",
  phone: "604-555-0100",
  address: "123 Moss Ave, Vancouver, BC",
  created_at: "2023-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

export const fixtureCustomer2: Customer = {
  id: 202,
  name: "Oakwood Properties",
  email: "contact@oakwood.ca",
  phone: "604-555-0200",
  address: "789 Birch Rd, Burnaby, BC",
  created_at: "2023-03-01T00:00:00Z",
  updated_at: "2023-03-01T00:00:00Z",
};

export const fixtureCustomers: Customer[] = [fixtureCustomer1, fixtureCustomer2];

export const fixtureAttachment1: Attachment = {
  id: 401,
  project_id: 101,
  entity_type: "project",
  entity_id: 101,
  filename: "contract-signed.pdf",
  content_type: "application/pdf",
  size: 204800,
  url: "https://moss.buildtools.app/attachments/401",
  created_at: "2024-01-15T09:00:00Z",
  updated_at: "2024-01-15T09:00:00Z",
};

export const fixtureAttachment2: Attachment = {
  id: 402,
  project_id: 101,
  entity_type: "change_order",
  entity_id: 301,
  filename: "deck-extension-drawings.pdf",
  content_type: "application/pdf",
  size: 512000,
  url: "https://moss.buildtools.app/attachments/402",
  created_at: "2024-03-01T10:00:00Z",
  updated_at: "2024-03-01T10:00:00Z",
};

export const fixtureAttachments: Attachment[] = [
  fixtureAttachment1,
  fixtureAttachment2,
];
