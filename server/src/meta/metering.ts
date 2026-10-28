/**
 * Metering: one line per served request appended to `server/logs/costs.csv`
 * (time, session, route, model, source, input/cached/output tokens, images,
 * usd). Only `upstream` lines cost money; the global budget is the sum of
 * upstream USD, so it survives restarts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewaySource } from "@fitroom/shared";
import type { TokenUsage } from "./pricing.js";

export const COSTS_HEADER =
  "time,session,route,model,source,input_tokens,cached_input_tokens,output_tokens,images,usd";

export interface CostLine {
  time: string;
  session: string;
  route: string;
  model: string;
  source: GatewaySource;
  usage: TokenUsage;
  usd: number;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function costsFile(logsDir: string): string {
  return join(logsDir, "costs.csv");
}

export function appendCostLine(logsDir: string, line: CostLine): void {
  mkdirSync(logsDir, { recursive: true });
  const file = costsFile(logsDir);
  if (!existsSync(file)) {
    appendFileSync(file, `${COSTS_HEADER}\n`, "utf8");
  }
  const row = [
    line.time,
    line.session,
    line.route,
    line.model,
    line.source,
    String(line.usage.inputTokens),
    String(line.usage.cachedInputTokens),
    String(line.usage.outputTokens),
    String(line.usage.images),
    String(line.usd),
  ]
    .map(csvCell)
    .join(",");
  appendFileSync(file, `${row}\n`, "utf8");
}

/**
 * Sum of `upstream` USD in costs.csv (0 when the file is missing). When
 * `fromIso` is set, only rows with `time` at or after it count: both forms
 * are `toISOString`, so the comparison is lexicographic.
 */
export function readUpstreamTotalUsd(logsDir: string, fromIso?: string | null): number {
  const file = costsFile(logsDir);
  if (!existsSync(file)) return 0;
  let total = 0;
  const lines = readFileSync(file, "utf8").split("\n");
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const cells = splitCsv(line);
    if (cells[4] !== "upstream") continue;
    if (fromIso !== undefined && fromIso !== null && fromIso !== "") {
      if ((cells[0] ?? "") < fromIso) continue;
    }
    const usd = Number(cells[9]);
    if (Number.isFinite(usd) && usd > 0) total += usd;
  }
  return Math.round(total * 1_000_000) / 1_000_000;
}
