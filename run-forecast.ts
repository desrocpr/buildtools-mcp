import { BuildToolsAPI } from "./src/client/BuildToolsAPI.js";
import { cashFlowForecastTool } from "./src/tools/forecasts.js";
async function run(args: any, label: string) {
  console.log(`\n========== ${label} ==========\n`);
  const api = new BuildToolsAPI({
    tenant: "moss", baseUrl: process.env.BUILDTOOLS_BASE_URL!,
    username: process.env.BUILDTOOLS_USERNAME!, password: process.env.BUILDTOOLS_PASSWORD!,
    authUrl: process.env.BUILDTOOLS_AUTH_URL,
  } as any);
  const r = await cashFlowForecastTool.handler(args, api);
  console.log((r.content[0] as any).text);
}
async function main() {
  await run({ project_ids: [185907], granularity: "monthly", horizon_periods: 6 }, "KATCHMARK (monthly, 6mo)");
  await run({ team: "all_active", granularity: "quarterly", horizon_periods: 3 }, "COMPANY-WIDE (quarterly, 3q = Q2/Q3/Q4)");
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
