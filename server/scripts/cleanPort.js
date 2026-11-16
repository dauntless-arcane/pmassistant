import "dotenv/config";
import { execSync } from "child_process";

const port = process.env.PORT || 4000;

function pidsOnPortWindows(port) {
  const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
  const pids = new Set();
  for (const line of out.split("\n")) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (match && Number(match[1]) === Number(port)) pids.add(match[2]);
  }
  return [...pids];
}

function pidsOnPortPosix(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf8" });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const pids = process.platform === "win32" ? pidsOnPortWindows(port) : pidsOnPortPosix(port);

if (pids.length === 0) {
  console.log(`Nothing is listening on port ${port}.`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "inherit" });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: "inherit" });
    }
    console.log(`Killed PID ${pid} on port ${port}.`);
  } catch (err) {
    console.error(`Failed to kill PID ${pid}: ${err.message}`);
  }
}
