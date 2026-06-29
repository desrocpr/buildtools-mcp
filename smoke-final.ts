import { BuildToolsAPI } from "./src/client/BuildToolsAPI.js";
import { buildMossDbFromEnv } from "./src/db/MossDb.js";
import { uncollectedInvoicesTool } from "./src/tools/invoices.js";
import { cashFlowForecastTool } from "./src/tools/forecasts.js";
async function main() {
  const api = new BuildToolsAPI({
    tenant: "moss", baseUrl: process.env.BUILDTOOLS_BASE_URL!,
    username: process.env.BUILDTOOLS_USERNAME!, password: process.env.BUILDTOOLS_PASSWORD!,
  } as any);
  api.db = buildMossDbFromEnv();
  const t1 = Date.now();
  const r1 = await uncollectedInvoicesTool.handler({ team: "all_active", window_days: 7 }, api);
  console.log(`uncollected_invoices all_active 7d: ${((Date.now()-t1)/1000).toFixed(1)}s`);
  console.log((r1.content[0] as any).text);
  console.log("\n===\n");
  const t2 = Date.now();
  const r2 = await cashFlowForecastTool.handler({ team: "all_active", granularity: "quarterly", horizon_periods: 3 }, api);
  console.log(`cash_flow_forecast all_active quarterly 3q: ${((Date.now()-t2)/1000).toFixed(1)}s`);
  console.log((r2.content[0] as any).text.slice(0, 4000));
  await api.db!.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
