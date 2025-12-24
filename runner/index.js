#!/usr/bin/env node
const { execSync, spawnSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const mustache = require("mustache");

// ---------------- 1) CLI 参数 ----------------
const projectPath = process.argv[2];
if (!projectPath) {
  console.error(
    "Usage: node index.js <project-path> [baseBranch] [targetBranch] [--full]"
  );
  process.exit(1);
}

const cliBase = process.argv[3] || "";
const cliTarget = process.argv[4] || "";
const forceFull = process.argv.includes("--full");

let baseBranch = cliBase || process.env.CR_BASE_BRANCH || "";
let targetBranch = cliTarget || process.env.CR_TARGET_BRANCH || "";

const ROOT = path.join(__dirname, "..");
const OUTDIR = path.join(ROOT, "review-output");
fs.ensureDirSync(OUTDIR);

const modelName = process.env.CR_MODEL || "qwen3-vl:8b";

// ---------------- 工具函数 ----------------
function sh(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

function parseNameStatusLine(line) {
  const parts = line.split("\t").filter(Boolean);
  if (!parts.length) return null;

  const statusRaw = parts[0]; // M / A / D / Rxxx
  const status = statusRaw.startsWith("R") ? "R" : statusRaw;
  if (status === "R") {
    return { status: "R", oldPath: parts[1], path: parts[2] };
  }
  return { status, path: parts[1] };
}

// .gitignore 忽略：用 git check-ignore
function isIgnoredByGit(projectPath, relPath) {
  try {
    const r = spawnSync(
      "git",
      ["-C", projectPath, "check-ignore", "-q", relPath],
      { stdio: "ignore" }
    );
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// 从 diff 文本拆成按文件分组的 unified diff blocks
function splitUnifiedDiffByFile(diffText) {
  const blocks = [];
  if (!diffText || !diffText.trim()) return blocks;

  const lines = diffText.split("\n");
  let cur = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (cur) blocks.push(cur);
      cur = { header: line, file: "", text: line + "\n" };
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) cur.file = m[2];
      continue;
    }
    if (cur) cur.text += line + "\n";
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// LLM 输出容错提取 JSON
function extractJSON(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}

  const m = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (m && m[1]) {
    try {
      return JSON.parse(m[1]);
    } catch (_) {}
  }

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const sub = text.slice(first, last + 1);
    try {
      return JSON.parse(sub);
    } catch (_) {}
  }
  return null;
}

// 组员统计：按作者聚合 commits/lines/files
function buildAuthorStats(projectPath, base, target) {
  let out = "";
  try {
    out = sh(
      `git -C "${projectPath}" log ${base}..${target} --pretty="@@@%an|%ae" --numstat`
    );
  } catch (_) {
    return [];
  }

  const lines = out.split("\n");
  const map = new Map(); // key=email -> {name,email,commits,add,del,files:Set}
  let current = null;

  for (const line of lines) {
    if (line.startsWith("@@@")) {
      const [name, email] = line.replace("@@@", "").split("|");
      current = email || name;
      if (!map.has(current)) {
        map.set(current, {
          name: name || "",
          email: email || "",
          commits: 0,
          add: 0,
          del: 0,
          files: new Set(),
        });
      }
      map.get(current).commits += 1;
      continue;
    }
    const parts = line.split("\t");
    if (parts.length === 3 && current && map.has(current)) {
      const add = parts[0] === "-" ? 0 : Number(parts[0] || 0);
      const del = parts[1] === "-" ? 0 : Number(parts[1] || 0);
      const file = parts[2] || "";
      const rec = map.get(current);
      rec.add += add;
      rec.del += del;
      if (file) rec.files.add(file);
    }
  }

  return Array.from(map.values()).map((x) => ({
    ...x,
    files: Array.from(x.files).slice(0, 50),
    fileCount: x.files.size,
  }));
}

// ---------------- 2) 分支兜底识别 ----------------
let currentBranch = "";
try {
  currentBranch = sh(
    `git -C "${projectPath}" rev-parse --abbrev-ref HEAD`
  ).trim();
} catch (_) {}

if (!baseBranch) {
  try {
    const branches = sh(`git -C "${projectPath}" branch -a`);
    if (branches.includes(" main") || branches.includes(" remotes/origin/main"))
      baseBranch = "main";
    else if (
      branches.includes(" master") ||
      branches.includes(" remotes/origin/master")
    )
      baseBranch = "master";
    else baseBranch = "HEAD~1";
  } catch (_) {
    baseBranch = "HEAD~1";
  }
}
if (!targetBranch) targetBranch = "HEAD";

console.log("Base Branch:", baseBranch);
console.log("Target Branch:", targetBranch);
console.log("Current Branch:", currentBranch || "unknown");
console.log("Force full scan:", forceFull ? "YES" : "NO");

// ---------------- 3) 获取变更清单（A/M/D/R），并尊重 .gitignore ----------------
const CODE_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".vue",
  ".kt",
  ".kts",
  ".swift",
  ".java",
  ".m",
  ".mm",
  ".cs",
  ".go",
  ".py",
  ".php",
  ".json",
  ".scss",
  ".css",
]);

let changeItems = [];
try {
  const cmd = `git -C "${projectPath}" diff ${baseBranch}...${targetBranch} --name-status -M`;
  const out = sh(cmd);
  const lines = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const line of lines) {
    const item = parseNameStatusLine(line);
    if (!item || !item.path) continue;

    // 忽略 gitignore
    if (isIgnoredByGit(projectPath, item.path)) continue;

    // 只保留代码/配置
    const ext = path.extname(item.path);
    if (ext && !CODE_EXTS.has(ext)) continue;

    changeItems.push(item);
  }
} catch (e) {
  console.warn("Failed to get name-status diff:", e.message || e);
}

console.log("Changed items:");
changeItems.forEach((it) => {
  if (it.status === "R") console.log(`  - R  ${it.oldPath} -> ${it.path}`);
  else console.log(`  - ${it.status}  ${it.path}`);
});

const changedFiles = changeItems.map((it) => it.path).filter(Boolean);

// ---------------- 4) Semgrep（p/default + custom rules） ----------------
console.log("Running semgrep ...");

let semgrepJson = null;
let semgrepRaw = "";
let semgrepFindings = [];

const vueRulesPath = path.join(ROOT, "rules", "vue.yaml");
const uniappRulesPath = path.join(ROOT, "rules", "uniapp.yaml");

// 你要过滤的那种 raw dom / innerHTML / document.write 的提示：直接排除
const EXCLUDE_RULES = [
  "javascript.browser.security.raw-dom.raw-dom",
  "javascript.browser.security.innerhtml.innerhtml",
  "javascript.browser.security.document-write.document-write",
];

try {
  const outPath = path.join(OUTDIR, "semgrep.json");
  const env = { ...process.env, PYTHONUTF8: "1" };

  const targets = [];
  if (!forceFull && changedFiles.length > 0) {
    console.log("Semgrep will scan changed files only.");
    for (const rel of changedFiles) targets.push(path.join(projectPath, rel));
  } else {
    console.log("Semgrep will scan entire project.");
    targets.push(projectPath);
  }

  const args = [
    "--config",
    "p/default",
    ...(fs.existsSync(vueRulesPath) ? ["--config", vueRulesPath] : []),
    ...(fs.existsSync(uniappRulesPath) ? ["--config", uniappRulesPath] : []),
    ...EXCLUDE_RULES.flatMap((r) => ["--exclude-rule", r]),
    "--json",
    "-o",
    outPath,
    ...targets,
  ];

  const r = spawnSync("semgrep", args, { stdio: "inherit", env });
  if (r.error) throw r.error;

  if (fs.existsSync(outPath)) {
    semgrepRaw = fs.readFileSync(outPath, "utf8");
    semgrepJson = JSON.parse(semgrepRaw);
  }
} catch (e) {
  console.warn("Semgrep failed (continue):", e.message || e);
}

if (semgrepJson && Array.isArray(semgrepJson.results)) {
  semgrepFindings = semgrepJson.results.map((r) => {
    const extra = r.extra || {};
    const start = r.start || {};
    const sev =
      extra.severity || (extra.metadata && extra.metadata.severity) || "";
    const msg =
      extra.message ||
      (extra.metadata &&
        (extra.metadata.shortMessage || extra.metadata.description)) ||
      "";
    return {
      path: r.path,
      line: start.line || "",
      col: start.col || "",
      rule_id: r.check_id,
      severity: String(sev || "").toUpperCase(),
      message: msg || "",
    };
  });
}
console.log("Parsed Semgrep findings:", semgrepFindings.length);

// ---------------- 5) diff.patch（用于 LLM + HTML 展示） ----------------
console.log("Generating diff.patch ...");

let diffData = "";
try {
  diffData = sh(`git -C "${projectPath}" diff ${baseBranch}...${targetBranch}`);
  fs.writeFileSync(path.join(OUTDIR, "diff.patch"), diffData, "utf8");
} catch (e) {
  console.warn("git diff failed:", e.message || e);
}

const diffBlocks = splitUnifiedDiffByFile(diffData);
const diffByFile = {};
for (const b of diffBlocks) {
  if (!b.file) continue;
  diffByFile[b.file] = b.text;
}

// diff 截断给 LLM，避免过长卡死
const MAX_DIFF_LINES = 1200;
let truncatedDiff = diffData;
if (diffData) {
  const lines = diffData.split("\n");
  if (lines.length > MAX_DIFF_LINES) {
    truncatedDiff =
      lines.slice(0, MAX_DIFF_LINES).join("\n") +
      `\n\n... [diff truncated total=${lines.length}]`;
  }
}

// ---------------- 6) 作者统计 ----------------
const authorStats = buildAuthorStats(projectPath, baseBranch, targetBranch);

// ---------------- 7) 打分机制（降噪） ----------------
const STYLE_RULE_IDS = new Set(["vue-unused-variable", "vue-no-console"]);

const SCORE_CONFIG = {
  deduct: {
    CRITICAL: { per: 8, max: 40 },
    ERROR: { per: 6, max: 35 },
    HIGH: { per: 4, max: 30 },
    MEDIUM: { per: 2, max: 22 },
    WARNING: { per: 1, max: 18 },
    LOW: { per: 0.5, max: 10 },
    INFO: { per: 0.2, max: 6 },
  },
  llm: { per: 2, max: 20 },
};

function calcScore(semgrepFindings, llmIssues) {
  let score = 100;
  const buckets = {
    CRITICAL: 0,
    ERROR: 0,
    HIGH: 0,
    MEDIUM: 0,
    WARNING: 0,
    LOW: 0,
    INFO: 0,
  };

  for (const f of semgrepFindings) {
    if (STYLE_RULE_IDS.has(f.rule_id)) continue; // 样式类不扣分
    const sev = (f.severity || "INFO").toUpperCase();
    buckets[sev] = (buckets[sev] ?? 0) + 1;
  }

  for (const sev of Object.keys(buckets)) {
    const cfg = SCORE_CONFIG.deduct[sev];
    const count = buckets[sev];
    if (!cfg || !count) continue;
    score -= Math.min(cfg.max, count * cfg.per);
  }

  const llmCount = (llmIssues || []).length;
  if (llmCount)
    score -= Math.min(SCORE_CONFIG.llm.max, llmCount * SCORE_CONFIG.llm.per);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let labelZh, labelEn;
  if (score >= 90) {
    labelZh = "优秀";
    labelEn = "Excellent";
  } else if (score >= 75) {
    labelZh = "良好";
    labelEn = "Good";
  } else if (score >= 60) {
    labelZh = "一般";
    labelEn = "Fair";
  } else {
    labelZh = "较差";
    labelEn = "Poor";
  }

  let level = "poor";
  if (score >= 90) level = "excellent";
  else if (score >= 75) level = "good";
  else if (score >= 60) level = "fair";

  return { score, labelZh, labelEn, level, buckets };
}

// ---------------- 8) 调用本地 Ollama：输出“逐文件修改项” ----------------
const prompt = `
You are a senior reviewer for a UniApp/Vue admin project.

Input:
1) Branch comparison: base="${baseBranch}" target="${targetBranch}"
2) Changed items list (A/M/D/R) + file paths
3) Semgrep findings (JSON)
4) Git diff (possibly truncated)

Output ONLY JSON:
{
  "summary_en": string,
  "summary_zh": string,
  "items": [
    {
      "status": "A|M|D|R",
      "file": string,
      "what_changed_zh": string,
      "risk_zh": string,
      "suggestions_zh": [string]
    }
  ],
  "overall_suggestions_zh": [string]
}

Rules:
- For each item, infer "what_changed" from diff context (do NOT hallucinate).
- If a file has no diff content, say "未获取到具体 diff，基于文件名推测风险点" and keep suggestions conservative.
- Focus on: i18n usage, UI text consistency, status enum consistency, form validation, API integration, UniApp specifics.
- Do NOT talk about repository structure errors.
- Keep suggestions actionable and short.

Changed items:
${JSON.stringify(changeItems, null, 2)}

Semgrep JSON:
${semgrepRaw || "null"}

Git diff:
${truncatedDiff && truncatedDiff.trim() ? truncatedDiff : "[NO_DIFF]"}
`;

let llmOutput = "";
try {
  console.log(`Calling ollama (${modelName})...`);
  const p = spawnSync("ollama", ["run", modelName], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 30,
  });
  if (p.error) throw p.error;
  llmOutput = (p.stdout || "").trim() || (p.stderr || "").trim();
  if (!llmOutput) throw new Error("empty output");
  fs.writeFileSync(path.join(OUTDIR, "llm.json"), llmOutput, "utf8");
} catch (e) {
  console.warn("ollama failed, fallback JSON:", e.message || e);
  const fallback = {
    summary_en: "LLM unavailable",
    summary_zh: "LLM 暂不可用（已回退）",
    items: [],
    overall_suggestions_zh: [],
  };
  llmOutput = JSON.stringify(fallback, null, 2);
  fs.writeFileSync(path.join(OUTDIR, "llm.json"), llmOutput, "utf8");
}

const llmJson = extractJSON(llmOutput) || {
  summary_en: "",
  summary_zh: "",
  items: [],
  overall_suggestions_zh: [],
};

// 给 LLM items 自动挂载对应 diff 代码块（方便你查验）
if (llmJson && Array.isArray(llmJson.items)) {
  llmJson.items = llmJson.items.map((it) => ({
    ...it,
    diff: diffByFile[it.file] || "",
  }));
}

const llmIssues = []; // 目前不单独扣 LLM issues

// ---------------- 9) 总分 + view ----------------
const scoreInfo = calcScore(semgrepFindings, llmIssues);
const scanAt = new Date().toLocaleString();

// pretty raw semgrep
let semgrepRawStr = "";
if (semgrepJson) {
  try {
    semgrepRawStr = JSON.stringify(semgrepJson, null, 2);
  } catch (_) {
    semgrepRawStr = String(semgrepJson);
  }
}

const view = {
  stats: {
    projectPath,
    baseBranch,
    targetBranch,
    modelName,
    scanAt,
    forceFull: forceFull ? "YES" : "NO",
    semgrepCount: semgrepFindings.length,
    codeScore: scoreInfo.score,
    scoreLabelZh: scoreInfo.labelZh,
    scoreLabelEn: scoreInfo.labelEn,
    scoreLevel: scoreInfo.level,
    severityBuckets: scoreInfo.buckets,
  },

  changeItems: changeItems.map((it) => ({
    status: it.status,
    file: it.path,
    oldFile: it.oldPath || "",
    isRename: it.status === "R",
  })),
  hasChanges: changeItems.length > 0,

  llm: llmJson,
  hasAiItems: Array.isArray(llmJson.items) && llmJson.items.length > 0,

  authorStats,
  hasAuthorStats: authorStats.length > 0,

  hasSemgrep: semgrepFindings.length > 0,
  semgrepFindings,
  semgrepRaw: semgrepRawStr,

  diffBlocks: diffBlocks.map((b) => ({
    file: b.file || "(unknown)",
    text: b.text || "",
  })),
  hasDiffBlocks: diffBlocks.length > 0,
};

// ---------------- 10) 渲染 HTML ----------------
console.log("Rendering HTML report...");
const tplPath = path.join(__dirname, "templates", "report.tpl.html");
const tpl = fs.readFileSync(tplPath, "utf8");

const html = mustache.render(tpl, view);
const htmlPath = path.join(OUTDIR, "report.html");
fs.writeFileSync(htmlPath, html, "utf8");

console.log(
  `Done. Score: ${scoreInfo.score} (${scoreInfo.labelZh}/${scoreInfo.labelEn})`
);
console.log("Report generated:", htmlPath);
