import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTPAY_HOME } from "./config.js";
import { chat, chatReady } from "./chat.js";

/**
 * Standing instructions: things the user wants the agent to buy on its own, on
 * a schedule, with nobody prompting it at the time. The user sets them in the
 * web interface; a timer in this process runs each one when it is due, through
 * the same agent and tools as the chat console. The user's spending limits
 * apply exactly as they do to any other purchase.
 */

export interface StandingInstruction {
  id: string;
  text: string;
  everyHours: number;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
}

const FILE = join(AGENTPAY_HOME, "standing.json");
const TICK_MS = Number(process.env.AGENTPAY_STANDING_TICK_SECONDS ?? 60) * 1000;
const MAX_INSTRUCTIONS = 10;

export function loadStanding(): StandingInstruction[] {
  if (!existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as StandingInstruction[]) : [];
  } catch {
    return [];
  }
}

function save(list: StandingInstruction[]) {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

export function addStanding(text: string, everyHours: number): StandingInstruction {
  const clean = text.trim();
  if (clean.length < 3 || clean.length > 300) throw new Error("Write an instruction of up to 300 characters.");
  if (!Number.isFinite(everyHours) || everyHours < 1 || everyHours > 720) {
    throw new Error("Choose how often it should run.");
  }
  const list = loadStanding();
  if (list.length >= MAX_INSTRUCTIONS) throw new Error("Remove an instruction before adding another.");
  const item: StandingInstruction = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: clean,
    everyHours,
    createdAt: new Date().toISOString(),
  };
  save([...list, item]);
  return item;
}

export function removeStanding(id: string) {
  save(loadStanding().filter((item) => item.id !== id));
}

function prompt(text: string): string {
  return [
    `This is a standing instruction the user set earlier. Nobody is here to answer questions, so do not ask any.`,
    `Instruction: "${text}"`,
    `Decide whether anything needs buying now. If it does, buy it with decidedBy "agent" and a reason that names this standing instruction. A purchase beyond the user's limits will wait for their approval, which is fine.`,
    `Reply in one or two sentences saying what you did.`,
  ].join("\n");
}

let running = false;

/** Run every instruction that is due. A new instruction first runs at the next check. */
async function runDue() {
  if (running || !chatReady()) return;
  running = true;
  try {
    for (const item of loadStanding()) {
      const due = !item.lastRunAt || Date.now() - Date.parse(item.lastRunAt) >= item.everyHours * 3_600_000;
      if (!due) continue;
      let result: string;
      try {
        result = (await chat([{ role: "user", content: prompt(item.text) }])).reply;
      } catch (e: any) {
        result = `Did not run: ${e?.message ?? String(e)}`;
      }
      // Read the list again so a change made during the run is not lost.
      const list = loadStanding();
      const current = list.find((x) => x.id === item.id);
      if (current) {
        current.lastRunAt = new Date().toISOString();
        current.lastResult = result.slice(0, 500);
        save(list);
      }
    }
  } finally {
    running = false;
  }
}

export function startStanding() {
  const timer = setInterval(() => void runDue(), TICK_MS);
  timer.unref();
}
