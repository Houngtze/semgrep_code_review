#!/usr/bin/env node
const { execSync, spawnSync } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const mustache = require("mustache");
const ignore = require("ignore");

// -------- 1. 参数检查 --------
const projectPath = process.argv[2];
if (!projectPath) {
  console.error("Usage: node index.js <project-path>");
  process.exit(1);
}

// 根目录：review-tools 根
const ROOT = path.join(__dirname, "..");
// 输出目录：review-output
const OUTDIR = path.join(ROOT, "review-output");
fs.ensureDirSync(OUTDIR);

// ==================== 评分相关配置 ====================

// 这些规则只做提示，不参与扣分
const STYLE_RULE_IDS = new Set([
  "vue-unused-variable",
  "vue-no-console",
  "uniapp-console-sensitive-log",
]);

// 完全屏蔽（不显示、不计分）的规则 ID
const BLOCKED_RULE_IDS = new Set([
  "javascript.browser.security.raw-dom.raw-dom",
  "javascript.browser.security.innerhtml.innerhtml",
  "javascript.browser.security.document-write.document-write",
]);

// 按 message 关键字屏蔽（防止规则 ID 有变更）
const BLOCKED_MESSAGE_PATTERNS = [
  "User controlled data in methods like `innerHTML`, `outerHTML` or `document.write` is an anti-pattern that can lead to XSS vulnerabilities",
];

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

  // Semgrep 扣分逻辑
  for (const f of semgrepFindings) {
    const sev = (f.severity || "").toUpperCase();
    const id = f.rule_id || "";

    // 样式级规则不扣分
    if (STYLE_RULE_IDS.has(id)) continue;

    if (buckets[sev] !== undefined) {
      buckets[sev] += 1;
    } else {
      buckets.INFO += 1;
    }
  }

  const deduct = {
    CRITICAL: { per: 7, max: 35 },
    ERROR: { per: 5, max: 30 },
    HIGH: { per: 3, max: 25 },
    MEDIUM: { per: 2, max: 20 },
    WARNING: { per: 1, max: 15 },
    LOW: { per: 0.5, max: 8 },
    INFO: { per: 0.5, max: 5 },
  };

  for (const sev of Object.keys(buckets)) {
    const count = buckets[sev];
    const cfg = deduct[sev];
    if (!cfg || count <= 0) continue;
    const d = Math.min(cfg.max, count * cfg.per);
    score -= d;
  }

  const llmCount = (llmIssues || []).length;
  if (llmCount > 0) {
    score -= Math.min(20, llmCount * 2);
  }

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

  return { score, labelZh, labelEn, buckets };
}

// ==================== 代码文件扩展名 & .gitignore ====================
const CODE_EXTS = [
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
];

let ig = ignore();
const gitignorePath = path.join(projectPath, ".gitignore");
if (fs.existsSync(gitignorePath)) {
  try {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    ig = ignore().add(gitignoreContent.split("\n"));
    console.log("Loaded .gitignore rules.");
  } catch (e) {
    console.warn("Failed to load .gitignore:", e.message || e);
  }
} else {
  console.log(".gitignore file not found.");
}

// ==================== 禁用的 Semgrep 规则（通过 --exclude-rule） ====================
const DISABLED_RULES = [
  "javascript.browser.security.raw-dom.raw-dom",
  "javascript.browser.security.innerhtml.innerhtml",
  "javascript.browser.security.document-write.document-write",
];

// ==================== 3. Git 改动文件（相对 master 分支） ====================
let changedFiles = [];
let useChangedOnly = false;
let currentBranch = "";
const baseBranch = "master";

try {
  currentBranch = execSync(
    `git -C "${projectPath}" rev-parse --abbrev-ref HEAD`,
    { encoding: "utf8" }
  ).trim();
} catch (e) {
  console.warn("Unable to detect current branch via git.", e.message || e);
}

console.log("Base Branch:", baseBranch);
console.log("Current Branch:", currentBranch || "unknown");

try {
  const diffList = execSync(
    `git -C "${projectPath}" diff ${baseBranch}...HEAD --name-only`,
    { encoding: "utf8" }
  );
  const raw = diffList
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

  changedFiles = raw
    .filter((f) => CODE_EXTS.includes(path.extname(f)))
    .filter((f) => !ig.ignores(f));

  if (changedFiles.length > 0) {
    useChangedOnly = true;
    console.log("Changed files to scan (relative to project root):");
    changedFiles.forEach((f) => console.log("  -", f));
  } else {
    console.log("No changed code files detected, will scan full project.");
  }
} catch (e) {
  console.warn(
    "git diff for changed files failed, will scan full project.",
    e.message || e
  );
  changedFiles = [];
  useChangedOnly = false;
}

// ==================== 4. Semgrep 扫描 ====================
console.log("Running semgrep (p/default)...");

let semgrepJson = null;
let semgrepData = "";

try {
  const outPath = path.join(OUTDIR, "semgrep.json");
  const env = { ...process.env, PYTHONUTF8: "1" };

  const targets = [];
  if (useChangedOnly && changedFiles.length > 0) {
    console.log("Semgrep will scan changed files only.");
    for (const rel of changedFiles) {
      targets.push(path.join(projectPath, rel));
    }
  } else {
    console.log(
      "Semgrep will scan entire project path (semgrep will apply its own ignore rules)."
    );
    targets.push(projectPath);
  }

  const vueRulesPath = path.join(ROOT, "rules", "vue.yaml");
  const uniappRulesPath = path.join(ROOT, "rules", "uniapp.yaml");

  const args = [
    "--config",
    "p/default",
    ...(fs.existsSync(vueRulesPath) ? ["--config", vueRulesPath] : []),
    ...(fs.existsSync(uniappRulesPath) ? ["--config", uniappRulesPath] : []),
    ...DISABLED_RULES.flatMap((r) => ["--exclude-rule", r]),
    "--json",
    "-o",
    outPath,
    ...targets,
  ];

  const res = spawnSync("semgrep", args, {
    stdio: "inherit",
    env,
  });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    console.warn("Semgrep exited with non-zero status, continuing anyway.");
  }

  if (fs.existsSync(outPath)) {
    semgrepData = fs.readFileSync(outPath, "utf8");
    try {
      semgrepJson = JSON.parse(semgrepData);
    } catch (e) {
      console.warn("Failed to parse semgrep.json:", e.message);
      semgrepJson = null;
    }
  }
} catch (e) {
  console.warn(
    "semgrep failed — continuing without semgrep findings.",
    e.message || e
  );
}

// ==================== 4.5 压缩 + 过滤 Semgrep 结果 ====================
let semgrepFindings = [];
if (semgrepJson && Array.isArray(semgrepJson.results)) {
  for (const r of semgrepJson.results) {
    const start = r.start || {};
    const extra = r.extra || {};
    const rawMsg =
      extra.message ||
      (extra.metadata &&
        (extra.metadata.shortMessage || extra.metadata.description)) ||
      "";
    const msg = rawMsg || "";
    const sev =
      extra.severity || (extra.metadata && extra.metadata.severity) || "";
    const ruleId = r.check_id || "";

    // 1) 按规则 ID 屏蔽
    if (BLOCKED_RULE_IDS.has(ruleId)) continue;

    // 2) 按 message 内容屏蔽（防止规则 ID 不一致）
    if (
      BLOCKED_MESSAGE_PATTERNS.some((p) =>
        msg.toLowerCase().includes(p.toLowerCase())
      )
    ) {
      continue;
    }

    semgrepFindings.push({
      path: r.path,
      line: start.line || "",
      col: start.col || "",
      rule_id: ruleId,
      message: msg,
      severity: (sev || "").toUpperCase(),
    });
  }
}

console.log(`Parsed Semgrep findings: ${semgrepFindings.length}`);

// ==================== 5. 生成 git diff（给 LLM 看改动内容） ====================
console.log("Generating diff for LLM...");
const diffPath = path.join(OUTDIR, "diff.patch");
let diffData = "";

try {
  const diffCmd = `git -C "${projectPath}" diff ${baseBranch}...HEAD`;
  diffData = execSync(diffCmd, { encoding: "utf8" });
  fs.writeFileSync(diffPath, diffData, "utf8");
} catch (e) {
  console.warn(
    "git diff for LLM failed — maybe no git history.",
    e.message || e
  );
  diffData = "";
}

let truncatedDiff = diffData;
const MAX_DIFF_LINES = 800;
if (diffData) {
  const lines = diffData.split("\n");
  if (lines.length > MAX_DIFF_LINES) {
    truncatedDiff =
      lines.slice(0, MAX_DIFF_LINES).join("\n") +
      `\n\n... [diff truncated, total lines = ${lines.length}]`;
  }
}

// ==================== 6. 组装 LLM 提示词 ====================
const prompt = `
You are a senior code reviewer. You will receive:
1) Semgrep findings as JSON.
2) Git diff (possibly truncated).

IMPORTANT:
- Do NOT report issues about "invalid scanning root", "invalid file paths" or repository structure.
- Do NOT invent non-existent errors.
- Only report issues that truly come from Semgrep findings or Git diff.
- If nothing is found, return empty arrays.
- If Git diff is empty or [NO_CODE_CHANGE], the repository likely has no recent changes.

Return ONLY a JSON object with:
- summary_en: string
- summary_zh: string
- issues: array of { path, line, severity, message, suggestion }
- suggestions: array of string
- severityCounts: object like { CRITICAL, HIGH, MEDIUM, LOW }

Semgrep findings JSON:
${semgrepData || "null"}

Git diff:
${
  truncatedDiff && truncatedDiff.trim().length > 0
    ? truncatedDiff
    : "[NO_CODE_CHANGE]"
}
`;

// ==================== 7. 调用本地 Ollama ====================
let llmOutput = "";
const modelName = process.env.CR_MODEL || "qwen2.5:1.5b";

try {
  console.log(`Calling ollama (${modelName})...`);

  const p = spawnSync("ollama", ["run", modelName], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });

  if (p.error) throw p.error;

  llmOutput = p.stdout || p.stderr || "";
  if (!llmOutput.trim()) {
    throw new Error("empty output from ollama");
  }

  fs.writeFileSync(path.join(OUTDIR, "llm.json"), llmOutput, "utf8");
} catch (e) {
  console.warn("ollama call failed, using fallback JSON. ", e.message || e);
  const fallback = {
    summary_en: "LLM unavailable — fallback analysis",
    summary_zh: "LLM 暂不可用，使用回退分析结果。",
    issues: [],
    suggestions: [],
    severityCounts: {},
  };
  llmOutput = JSON.stringify(fallback, null, 2);
  fs.writeFileSync(path.join(OUTDIR, "llm.json"), llmOutput, "utf8");
}

// ==================== 8. 处理 LLM 输出、统计信息 ====================
let llmJson;
let llmIssues = [];
try {
  llmJson = JSON.parse(llmOutput);
} catch (e) {
  llmJson = {
    summary_en: llmOutput,
    summary_zh: "",
    issues: [],
    suggestions: [],
    severityCounts: {},
  };
}

if (Array.isArray(llmJson.issues)) {
  llmIssues = llmJson.issues;
}

if (!llmJson.summary_en && llmJson.summary) {
  llmJson.summary_en = llmJson.summary;
}
if (!llmJson.summary_zh) {
  llmJson.summary_zh = "";
}

const scanAt = new Date().toLocaleString();

const scoreInfo = calcScore(semgrepFindings, llmIssues);

let scoreLevel = "poor";
if (scoreInfo.score >= 90) scoreLevel = "excellent";
else if (scoreInfo.score >= 75) scoreLevel = "good";
else if (scoreInfo.score >= 60) scoreLevel = "fair";

const stats = {
  semgrepCount: semgrepFindings.length,
  llmIssueCount: llmIssues.length,
  projectPath,
  modelName,
  scanAt,
  codeScore: scoreInfo.score,
  scoreLabelZh: scoreInfo.labelZh,
  scoreLabelEn: scoreInfo.labelEn,
  scoreLevel,
  severityBuckets: scoreInfo.buckets || {},
};

// ==================== 9. 渲染 HTML 报告 ====================
console.log("Rendering HTML report...");
const tplPath = path.join(__dirname, "templates", "report.tpl.html");
const tpl = fs.readFileSync(tplPath, "utf8");

let semgrepRawStr = "";
if (semgrepJson) {
  try {
    semgrepRawStr = JSON.stringify(semgrepJson, null, 2);
  } catch (e) {
    semgrepRawStr = String(semgrepJson);
  }
}

const view = {
  stats,
  hasSemgrep: semgrepFindings.length > 0,
  semgrepFindings,
  semgrepRaw: semgrepRawStr,
  hasLlmIssues: llmIssues.length > 0,
  llm: llmJson,
  llmIssues,
};

const html = mustache.render(tpl, view);
const htmlPath = path.join(OUTDIR, "report.html");
fs.writeFileSync(htmlPath, html, "utf8");

console.log("Report generated!", htmlPath);
